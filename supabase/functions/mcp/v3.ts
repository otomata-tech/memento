/**
 * Memento V3 — surface MCP, les 8 verbes (issue #55). Câblage page-centré.
 *
 * load · search · get · list · count · propose_changes · apply · share — typés contre
 * `server/src/mcp-contract.v3.ts`. Consomme les lots _shared :
 *   - access.v3.ts : `withCurrentSub` (pose request.jwt.claims 1×/transaction), `assertAccess`.
 *   - search.v3.ts : `search({sub}, args, {embedTexts})`.
 *   - entities.ts  : `resolvePageEntities` (NER async après apply) + `resolveMention` (assert_entity).
 *   - embed.v3.ts  : `embedTexts` (Mistral/1024) injecté dans search.
 *
 * SÉPARÉ de index.ts (surface v2 LIVE, intacte) : cutover = index.ts importera d'ici.
 * Pas de `Deno.serve` au top (sauf `import.meta.main`) → importable + testable sans
 * démarrer un serveur. Le dispatch des verbes est exporté pour le test du harness.
 *
 * Identité : on pose request.jwt.claims via withCurrentSub (1 transaction par verbe).
 * assertAccess ouvre sa propre transaction-identité (lot #56) → 1 round-trip de garde
 * + 1 transaction de travail ; acceptable, atomicité préservée par op à l'apply.
 */
// Logique des 8 verbes — SANS le SDK MCP (le transport vit dans v3_server.ts). Ce
// fichier est ainsi type-checkable (`deno check`) et testable ; la fonction mcp v2,
// elle, n'est pas checkable (le SDK n'expose pas de .d.ts) — d'où la séparation.
import { sql } from "drizzle-orm";
import { assertAccess, assertCanSetVisibility, withCurrentSub, AccessError, safeErrorMessage } from "../_shared/access.v3.ts";
import { ensurePersonalBaseV3 } from "../_shared/onboarding.v3.ts";
import { ensureAccount, emailsFor, subForEmail } from "../_shared/accounts.ts";
import { assertWithinLimit } from "../_shared/ratelimit.ts";
import { search as searchV3 } from "../_shared/search.v3.ts";
import { embedTexts } from "../_shared/embed.v3.ts";
import { defaultDeps, resolveMention, resolvePageEntities } from "../_shared/entities.ts";
import { indexPage } from "../_shared/indexing.v3.ts";
import { runDigest, type Digest } from "../_shared/digest.v3.ts";
import type {
  LoadResult, SearchHit, EntityRef, ProposeOp, TreeNode,
} from "../../../server/src/mcp-contract.v3.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

type Tx = typeof import("../_shared/db.ts").db;
export const LIST_KINDS = ["pages", "entities", "sources", "ingestions", "entity_review"] as const;
export type ListKind = (typeof LIST_KINDS)[number];
const rows = <T>(r: unknown) => r as unknown as T[];
const one = <T>(r: unknown) => (r as unknown as T[])[0];

// ── Résolution de base (1 base/org, ADR 0003) ─────────────────────────────────
// `base?` du contrat = UUID de base. Absent → la SEULE base énumérable de l'appelant
// (erreur si 0 ou plusieurs : on ne devine pas le tenant). [À VALIDER : slug vs uuid.]
async function resolveBaseId(tx: Tx, base?: string): Promise<string> {
  if (base) {
    const r = one<{ id: string }>(await tx.execute(sql`select id from mem_bases where id = ${base}::uuid`));
    if (!r) throw new AccessError("resource not found or access denied");
    return r.id;
  }
  const accessible = rows<{ id: string }>(await tx.execute(sql`select id from mem_bases where id in (select accessible_base_ids())`));
  if (accessible.length === 1) return accessible[0].id;
  if (!accessible.length) throw new Error("no accessible base — specify `base`");
  throw new Error("several accessible bases — specify `base`");
}

// ── Verbe bases : les bases énumérables de l'appelant (amorçage UI) ───────────
// Le front ne peut pas deviner un UUID de base → il appelle ce verbe en premier
// pour amorcer le sélecteur (corrige le wart `base?` du contrat côté client).
export async function v3Bases(sub: string): Promise<{ bases: { id: string; name: string; orgId: string; role: string }[] }> {
  await ensurePersonalBaseV3(sub); // #70 : un nouvel inscrit obtient org perso + base → pas de cul-de-sac.
  return withCurrentSub(sub, async (tx) => {
    const bases = rows<{ id: string; name: string; orgId: string; role: string }>(await tx.execute(sql`
      select b.id, b.name, b.org_id as "orgId", m.role
      from mem_bases b join mem_memberships m on m.org_id = b.org_id and m.user_id = mem_current_sub()
      order by b.name`));
    return { bases };
  });
}

async function orgIdOfBase(tx: Tx, baseId: string): Promise<string> {
  return one<{ org_id: string }>(await tx.execute(sql`select org_id from mem_bases where id = ${baseId}::uuid`)).org_id;
}

async function logRevision(
  tx: Tx, baseId: string, targetType: string, targetId: string | null, op: string,
  reason: string, actor: string, before: unknown, after: unknown, ingestionId: string | null,
) {
  await tx.execute(sql`
    insert into mem_revisions (base_id, target_type, target_id, op, reason, actor, actor_kind, before, after, ingestion_id)
    values (${baseId}, ${targetType}, ${targetId}, ${op}, ${reason}, ${actor}, 'agent',
            ${before ? JSON.stringify(before) : null}::jsonb, ${after ? JSON.stringify(after) : null}::jsonb, ${ingestionId})`);
}

// ── Verbe load : l'épine (guide + arbre N+2 + top entities + counts + etag) ────
export async function v3Load(sub: string, args: { base?: string; depth?: number }): Promise<LoadResult> {
  const depth = Math.min(Math.max(args.depth ?? 2, 1), 4);
  // Amorçage MCP-first (Claude appelle `load` d'abord) : sans base spécifiée, un nouvel
  // inscrit dead-end sur « no accessible base ». Provisionne d'abord (#70). Hors hot-path :
  // un load avec base explicite (cas répété) saute ce garde.
  if (!args.base) await ensurePersonalBaseV3(sub);
  return withCurrentSub(sub, async (tx) => {
    const baseId = await resolveBaseId(tx, args.base);
    await assertAccess(sub, { baseId }); // membre de l'org

    // Pages énumérables de la base, à profondeur ≤ depth, ordonnées (arbre).
    const pageRows = rows<{ id: string; parent_id: string | null; title: string; description: string; depth: number }>(
      await tx.execute(sql`
        select id, parent_id, title, description, depth from mem_pages
        where base_id = ${baseId} and status = 'active' and depth <= ${depth}
          and id in (select accessible_page_ids())
        order by depth, position`));

    // Guide = description de la page RACINE (parent_id null, 1re position).
    const guide = pageRows.find((p) => p.parent_id === null)?.description ?? "";

    // Arbre depuis les racines.
    const byParent = new Map<string | null, typeof pageRows>();
    for (const p of pageRows) {
      const k = p.parent_id;
      (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(p);
    }
    const build = (parentId: string | null): TreeNode[] =>
      (byParent.get(parentId) ?? []).map((p) => ({
        id: p.id, title: p.title, description: p.description,
        ...((byParent.get(p.id)?.length ?? 0) ? { children: build(p.id) } : {}),
      }));
    const tree = build(null);

    // top_entities (org), counts, etag.
    const orgId = await orgIdOfBase(tx, baseId);
    const topEntities = rows<EntityRef>(await tx.execute(sql`
      select e.id, e.type, e.canonical_label as label
      from mem_entities e
      left join mem_mentions m on m.entity_id = e.id
      where e.org_id = ${orgId} and not e.is_stub
      group by e.id, e.type, e.canonical_label
      order by count(m.*) desc nulls last limit 12`));
    const c = one<{ pages: number; entities: number; sources: number; ts: string | null }>(await tx.execute(sql`
      select
        (select count(*)::int from mem_pages p where p.base_id = ${baseId} and p.status='active' and p.id in (select accessible_page_ids())) as pages,
        (select count(*)::int from mem_entities e where e.org_id = ${orgId}) as entities,
        (select count(*)::int from mem_sources s where s.base_id = ${baseId}) as sources,
        (select max(updated_at)::text from mem_pages p where p.base_id = ${baseId}) as ts`));
    const counts = { pages: Number(c.pages), entities: Number(c.entities), sources: Number(c.sources) };
    const etag = `${counts.pages}:${counts.entities}:${c.ts ?? "0"}`;
    return { guide, tree, topEntities, counts, etag };
  });
}

// ── Verbe search : délègue à search.v3 (accès = prédicat d'énumération interne) ─
export function v3Search(
  sub: string,
  args: { q: string; scope?: "savoir" | "sources" | "both"; filters?: Record<string, unknown>; limit?: number },
): Promise<SearchHit[]> {
  return searchV3({ sub }, args as Parameters<typeof searchV3>[1], { embedTexts });
}

// ── Verbe get : page|entité (+ navigation locale) ─────────────────────────────
export function v3Get(sub: string, args: { id: string; kind: "page" | "entity"; include?: string[] }): Promise<unknown> {
  const include = new Set(args.include ?? []);
  return withCurrentSub(sub, async (tx) => {
    if (args.kind === "page") {
      await assertAccess(sub, { pageId: args.id });
      const page = one<Record<string, unknown>>(await tx.execute(sql`
        select id, base_id, parent_id, title, description, body, visibility, occurred_at, status, created_at, updated_at
        from mem_pages where id = ${args.id}::uuid`));
      if (!page) throw new AccessError("resource not found or access denied");
      const out: Record<string, unknown> = { kind: "page", ...page };
      if (include.has("children")) {
        out.children = rows(await tx.execute(sql`
          select id, title, description from mem_pages
          where parent_id = ${args.id}::uuid and status='active' and id in (select accessible_page_ids()) order by position`));
      }
      if (include.has("backlinks")) {
        out.entities = rows(await tx.execute(sql`
          select e.id, e.type, e.canonical_label as label from mem_mentions m
          join mem_entities e on e.id = m.entity_id where m.page_id = ${args.id}::uuid`));
      }
      if (include.has("sources")) {
        out.sources = rows(await tx.execute(sql`
          select s.id, s.kind, s.title, s.uri, s.citation, ps.locator from mem_page_sources ps
          join mem_sources s on s.id = ps.source_id where ps.page_id = ${args.id}::uuid`));
      }
      if (include.has("grants")) {
        // « Qui a accès » : réservé à qui peut GÉRER la page (write). Sinon `null` —
        // ni la liste ni son vide (un [] serait un oracle « personne d'autre »).
        const canManage = one<{ ok: boolean }>(await tx.execute(
          sql`select page_can_write(${args.id}::uuid) as ok`))?.ok === true;
        if (!canManage) {
          out.grants = null;
        } else {
          const g = rows<{ user_id: string; mode: string }>(await tx.execute(sql`
            select user_id, mode from mem_page_grants where page_id = ${args.id}::uuid order by created_at`));
          const emails = await emailsFor(g.map((x) => x.user_id));
          out.grants = g.map((x) => {
            const info = emails.get(x.user_id);
            return { userId: x.user_id, email: info?.email ?? null, mode: x.mode, pending: info?.pending ?? true };
          });
        }
      }
      return out;
    }
    // entité : lisible si l'org de l'entité est accessible (membre).
    const ent = one<{ id: string; org_id: string; type: string; canonical_label: string; normalised_label: string; aliases: string[]; page_id: string | null; is_stub: boolean; attributes: unknown }>(
      await tx.execute(sql`select id, org_id, type, canonical_label, normalised_label, aliases, page_id, is_stub, attributes from mem_entities where id = ${args.id}::uuid`));
    if (!ent) throw new AccessError("resource not found or access denied");
    const baseId = one<{ id: string }>(await tx.execute(sql`select id from mem_bases where org_id = ${ent.org_id}::uuid`))?.id;
    if (!baseId) throw new AccessError("resource not found or access denied");
    await assertAccess(sub, { baseId });
    const out: Record<string, unknown> = { kind: "entity", ...ent };
    if (include.has("backlinks")) {
      out.mentions = rows(await tx.execute(sql`
        select m.page_id, m.span, m.confidence, p.title from mem_mentions m
        join mem_pages p on p.id = m.page_id
        where m.entity_id = ${args.id}::uuid and p.id in (select accessible_page_ids())`));
    }
    return out;
  });
}

// ── Verbes list / count : déterministes, sous accès (énumérabilité) ───────────
function listQuery(kind: ListKind, baseId: string, orgId: string, filters: Record<string, unknown>) {
  switch (kind) {
    case "pages":
      return sql`select id, title, description, occurred_at, updated_at from mem_pages
        where base_id = ${baseId} and status='active' and id in (select accessible_page_ids())
        ${filters.type ? sql`` : sql``} order by updated_at desc`;
    case "entities":
      return sql`select id, type, canonical_label as label, is_stub from mem_entities
        where org_id = ${orgId} ${filters.type ? sql`and type = ${String(filters.type)}::mem_entity_type` : sql``}
        order by canonical_label`;
    case "sources":
      return sql`select id, kind, title, uri, occurred_at from mem_sources
        where base_id = ${baseId} order by created_at desc`;
    case "ingestions":
      return sql`select id, title, status, created_at from mem_ingestions
        where base_id = ${baseId} ${filters.status ? sql`and status = ${String(filters.status)}::mem_ingestion_status` : sql``}
        order by created_at desc`;
    case "entity_review":
      return sql`select id, entity_keep, entity_drop, score, method, status from mem_entity_reviews
        where org_id = ${orgId} ${filters.status ? sql`and status = ${String(filters.status)}::mem_entity_review_status` : sql`and status='pending'`}
        order by created_at desc`;
  }
}

export function v3List(
  sub: string, args: { kind: ListKind; base?: string; filters?: Record<string, unknown>; cursor?: string; limit?: number },
): Promise<{ items: unknown[]; totalCount: number; cursor: string | null }> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  // Curseur = offset opaque (ORDER BY stable dans listQuery) → 100% recall au-delà de la limite.
  const offset = Math.max(0, Math.trunc(Number(args.cursor ?? 0)) || 0);
  return withCurrentSub(sub, async (tx) => {
    const baseId = await resolveBaseId(tx, args.base);
    await assertAccess(sub, { baseId });
    const orgId = await orgIdOfBase(tx, baseId);
    const q = listQuery(args.kind, baseId, orgId, args.filters ?? {});
    const items = rows(await tx.execute(sql`${q} limit ${limit + 1} offset ${offset}`));
    const hasMore = items.length > limit;
    // totalCount = VRAI total (pas la taille de page) ; le curseur = offset de la page suivante.
    const totalCount = one<{ n: number }>(await tx.execute(sql`select count(*)::int n from (${q}) c`)).n;
    return { items: items.slice(0, limit), totalCount, cursor: hasMore ? String(offset + limit) : null };
  });
}

export function v3Count(sub: string, args: { kind: ListKind; base?: string; filters?: Record<string, unknown> }): Promise<{ total: number }> {
  return withCurrentSub(sub, async (tx) => {
    const baseId = await resolveBaseId(tx, args.base);
    await assertAccess(sub, { baseId });
    const orgId = await orgIdOfBase(tx, baseId);
    const total = rows(await tx.execute(sql`select 1 from (${listQuery(args.kind, baseId, orgId, args.filters ?? {})}) q`)).length;
    return { total };
  });
}

// ── Verbe propose_changes : matérialise une ingestion (NE MUTE RIEN) ──────────
export function v3ProposeChanges(
  sub: string, args: { title: string; base?: string; changes: ProposeOp[]; clientKey?: string },
): Promise<{ ingestionId: string; similarExisting: { pageId: string; score: number }[] }> {
  return withCurrentSub(sub, async (tx) => {
    const baseId = await resolveBaseId(tx, args.base);
    await assertAccess(sub, { baseId }); // proposer = accès lecture ; l'écriture est vérifiée à l'apply, par op.

    // Idempotence par (base, clientKey) : un re-stage ouvert REMPLACE le change-set.
    const existing = args.clientKey
      ? one<{ id: string; status: string }>(await tx.execute(sql`
          select id, status from mem_ingestions where base_id = ${baseId} and client_key = ${args.clientKey}`))
      : null;
    let ingestionId: string;
    if (existing && ["APPLIED", "REJECTED"].includes(existing.status)) {
      ingestionId = existing.id; // clos → no-op (dédupliqué)
    } else if (existing) {
      ingestionId = existing.id;
      await tx.execute(sql`update mem_ingestions set proposal = ${JSON.stringify(args.changes)}::jsonb, status='PROPOSED', title=${args.title} where id = ${existing.id}`);
    } else {
      ingestionId = one<{ id: string }>(await tx.execute(sql`
        insert into mem_ingestions (base_id, title, status, proposal, client_key, created_by)
        values (${baseId}, ${args.title}, 'PROPOSED', ${JSON.stringify(args.changes)}::jsonb, ${args.clientKey ?? null}, ${sub})
        returning id`)).id;
    }

    // similar_existing : best-effort FTS sur les titres des create_page proposés.
    const titles = args.changes.filter((c) => c.op === "create_page").map((c) => (c.payload as { title: string }).title).join(" ");
    const similarExisting = titles.trim()
      ? rows<{ pageId: string; score: number }>(await tx.execute(sql`
          select id as "pageId", ts_rank(body_fts, query) as score
          from mem_pages p, websearch_to_tsquery('french_unaccent', ${titles}) query
          where base_id = ${baseId} and status='active' and body_fts @@ query and id in (select accessible_page_ids())
          order by score desc limit 5`)).map((r) => ({ pageId: r.pageId, score: Number(r.score) }))
      : [];
    return { ingestionId, similarExisting };
  });
}

// ── Application d'UNE op (dans la transaction d'apply) ────────────────────────
// Retourne, le cas échéant, une page à (ré)indexer en NER après commit.
type NerTarget = { pageId: string; orgId: string; text: string };

async function applyOp(tx: Tx, sub: string, baseId: string, orgId: string, ingestionId: string, op: ProposeOp): Promise<NerTarget | null> {
  switch (op.op) {
    case "create_page": {
      const p = op.payload;
      await assertAccess(sub, { baseId }, { write: true });
      const parentDepth = p.parentId
        ? one<{ depth: number }>(await tx.execute(sql`select depth from mem_pages where id = ${p.parentId}::uuid`))?.depth ?? 0
        : -1;
      const pos = one<{ n: number }>(await tx.execute(sql`
        select coalesce(max(position),-1)+1 as n from mem_pages where base_id=${baseId} and parent_id is not distinct from ${p.parentId ?? null}::uuid`)).n;
      const id = one<{ id: string }>(await tx.execute(sql`
        insert into mem_pages (base_id, parent_id, title, description, body, depth, position, owner_id, created_by, updated_by)
        values (${baseId}, ${p.parentId ?? null}::uuid, ${p.title}, ${p.description}, ${p.body ?? ""}, ${parentDepth + 1}, ${pos}, ${sub}, ${sub}, ${sub})
        returning id`)).id;
      await logRevision(tx, baseId, "page", id, "create_page", "create_page", sub, null, { title: p.title }, ingestionId);
      return { pageId: id, orgId, text: `${p.title}\n${p.description}\n${p.body ?? ""}` };
    }
    case "update_page": {
      const p = op.payload;
      await assertAccess(sub, { pageId: p.pageId }, { write: true });
      const before = one<{ title: string; body: string }>(await tx.execute(sql`select title, body from mem_pages where id=${p.pageId}::uuid`));
      const body = p.body == null ? sql`body` : p.mode === "append" ? sql`body || E'\n' || ${p.body}` : sql`${p.body}`;
      await tx.execute(sql`
        update mem_pages set
          title = coalesce(${p.title ?? null}, title),
          description = coalesce(${p.description ?? null}, description),
          body = ${body}, updated_by = ${sub}
        where id = ${p.pageId}::uuid`);
      const after = one<{ title: string; body: string }>(await tx.execute(sql`select title, body from mem_pages where id=${p.pageId}::uuid`));
      await logRevision(tx, baseId, "page", p.pageId, "update_page", "update_page", sub, before, after, ingestionId);
      return { pageId: p.pageId, orgId, text: `${after.title}\n${after.body}` };
    }
    case "move_page": {
      const p = op.payload;
      await assertAccess(sub, { pageId: p.pageId }, { write: true });
      if (p.newParentId) await assertAccess(sub, { pageId: p.newParentId }, { write: true });
      await tx.execute(sql`update mem_pages set parent_id = ${p.newParentId ?? null}::uuid, position = ${p.position ?? 0} where id = ${p.pageId}::uuid`);
      await logRevision(tx, baseId, "page", p.pageId, "move_page", "move_page", sub, null, { newParentId: p.newParentId }, ingestionId);
      return null;
    }
    case "delete_page": {
      const p = op.payload;
      await assertAccess(sub, { pageId: p.pageId }, { write: true });
      await tx.execute(sql`delete from mem_pages where id = ${p.pageId}::uuid`);
      await logRevision(tx, baseId, "page", p.pageId, "delete_page", p.reason, sub, null, null, ingestionId);
      return null;
    }
    case "attach_source": {
      const p = op.payload;
      await assertAccess(sub, { pageId: p.pageId }, { write: true });
      const srcId = one<{ id: string }>(await tx.execute(sql`
        insert into mem_sources (base_id, kind, title, uri, content, citation, content_hash)
        values (${baseId}, ${p.source.kind}::mem_source_kind, ${p.source.title}, ${p.source.uri ?? null}, ${p.source.content ?? null}, ${p.source.citation ?? null},
                ${p.source.content ? sql`content_hash(${p.source.content})` : sql`null`})
        returning id`)).id;
      await tx.execute(sql`insert into mem_page_sources (page_id, source_id, locator) values (${p.pageId}::uuid, ${srcId}, ${p.locator ?? null}) on conflict do nothing`);
      await logRevision(tx, baseId, "source", srcId, "attach_source", "attach_source", sub, null, { title: p.source.title }, ingestionId);
      return null;
    }
    case "set_visibility": {
      const p = op.payload;
      await assertCanSetVisibility(sub, p.pageId, p.visibility);
      await tx.execute(sql`update mem_pages set visibility = ${p.visibility}::mem_page_visibility where id = ${p.pageId}::uuid`);
      await logRevision(tx, baseId, "page", p.pageId, "set_visibility", `→ ${p.visibility}`, sub, null, { visibility: p.visibility }, ingestionId);
      return null;
    }
    case "assert_entity": {
      const p = op.payload;
      await assertAccess(sub, { pageId: p.pageId }, { write: true });
      // entité LOGIQUE (decision) posée par l'agent → même escalier de résolution.
      await resolveMention(defaultDeps(), {
        orgId, pageId: p.pageId, type: "decision", label: p.label, span: p.span ?? null, actor: sub,
        attributes: { status: p.status, occurred_at: p.occurredAt, supersedes: p.supersedes },
      });
      await logRevision(tx, baseId, "entity", null, "assert_entity", p.label, sub, null, { label: p.label, status: p.status }, ingestionId);
      return null;
    }
    case "merge_entities": {
      const p = op.payload;
      await assertAccess(sub, { baseId }, { write: true });
      await tx.execute(sql`update mem_mentions set entity_id = ${p.keep}::uuid where entity_id = ${p.drop}::uuid
        and page_id not in (select page_id from mem_mentions where entity_id = ${p.keep}::uuid)`);
      await tx.execute(sql`delete from mem_mentions where entity_id = ${p.drop}::uuid`);
      await tx.execute(sql`update mem_entity_reviews set status='merged' where entity_keep=${p.keep}::uuid and entity_drop=${p.drop}::uuid`);
      await tx.execute(sql`delete from mem_entities where id = ${p.drop}::uuid and org_id = ${orgId}::uuid`);
      await logRevision(tx, baseId, "entity", p.keep, "merge_entities", `${p.drop}→${p.keep}`, sub, null, null, ingestionId);
      return null;
    }
    case "confirm_distinct": {
      const p = op.payload;
      await assertAccess(sub, { baseId }, { write: true });
      await tx.execute(sql`update mem_entity_reviews set status='distinct'
        where (entity_keep=${p.a}::uuid and entity_drop=${p.b}::uuid) or (entity_keep=${p.b}::uuid and entity_drop=${p.a}::uuid)`);
      return null;
    }
  }
}

// ── Verbe apply : idempotent (CAS claimed_at), écrit, déclenche NER async ──────
export async function v3Apply(sub: string, args: { ingestionId: string }): Promise<{ status: string }> {
  const nerTargets: NerTarget[] = [];
  const status = await withCurrentSub(sub, async (tx) => {
    // Claim atomique : un seul apply gagne ; un re-apply concurrent/rejoué → 0 ligne → no-op.
    // Un claim plus vieux que 5 min = apply crashé → réouvrable (interval SQL, pas de Date JS).
    const claimed = one<{ id: string }>(await tx.execute(sql`
      update mem_ingestions set claimed_at = now(), status = 'APPLYING'
      where id = ${args.ingestionId}::uuid and status not in ('APPLIED','REJECTED')
        and (claimed_at is null or claimed_at < now() - interval '5 minutes')
      returning id`));
    const ing = one<{ id: string; base_id: string; proposal: ProposeOp[]; status: string }>(await tx.execute(sql`
      select id, base_id, proposal, status from mem_ingestions where id = ${args.ingestionId}::uuid`));
    if (!ing) throw new Error("ingestion not found");
    if (!claimed) return ing.status; // déjà appliqué/en cours → no-op idempotent

    const baseId = ing.base_id;
    const orgId = await orgIdOfBase(tx, baseId);
    let allOk = true;
    for (const op of ing.proposal ?? []) {
      try {
        const t = await applyOp(tx, sub, baseId, orgId, ing.id, op);
        if (t) nerTargets.push(t);
      } catch (e) {
        allOk = false;
        await logRevision(tx, baseId, "ingestion", ing.id, op.op, `error: ${safeErrorMessage(e)}`, sub, null, null, ing.id);
      }
    }
    const final = allOk ? "APPLIED" : "PARTIAL";
    await tx.execute(sql`update mem_ingestions set status = ${final}::mem_ingestion_status, decided_by = ${sub}, decided_at = now(), claimed_at = null where id = ${ing.id}`);
    return final;
  });

  // APRÈS commit (la page existe ; non bloquant, best-effort) : extraction NER d'entités
  // + indexation sémantique (chunk + embed). Le FTS lexical, lui, marche déjà (body_fts).
  for (const t of nerTargets) {
    const ner = resolvePageEntities(defaultDeps(), { orgId: t.orgId, pageId: t.pageId, text: t.text })
      .catch((e) => console.warn("[mcp v3] NER skipped (non-blocking):", e instanceof Error ? e.message : e));
    const idx = indexPage(t.pageId, t.text)
      .catch((e) => console.warn("[mcp v3] indexing skipped (non-blocking):", e instanceof Error ? e.message : e));
    if (typeof EdgeRuntime !== "undefined") { EdgeRuntime.waitUntil(ner); EdgeRuntime.waitUntil(idx); }
  }
  return { status };
}

// ── Verbe review_ingestion : décisions de Revue Pages (reject / renvoi) ────────
// L'accept = `apply` ; ici les 2 autres issues d'une revue (CDC §8). Référent/admin (write).
// Idempotent : sur un statut terminal (APPLIED/REJECTED) → no-op.
export function v3ReviewIngestion(
  sub: string,
  args: { ingestionId: string; decision: "reject" | "send_back"; reviewNote?: string },
): Promise<{ status: string }> {
  return withCurrentSub(sub, async (tx) => {
    const ing = one<{ id: string; base_id: string; status: string }>(await tx.execute(sql`
      select id, base_id, status from mem_ingestions where id = ${args.ingestionId}::uuid`));
    if (!ing) throw new Error("ingestion not found");
    await assertAccess(sub, { baseId: ing.base_id }, { write: true });
    if (["APPLIED", "REJECTED"].includes(ing.status)) return { status: ing.status }; // terminal
    const newStatus = args.decision === "reject" ? "REJECTED" : "CHANGES_REQUESTED";
    await tx.execute(sql`
      update mem_ingestions set status = ${newStatus}::mem_ingestion_status,
        review_note = ${args.reviewNote ?? null}, decided_by = ${sub}, decided_at = now(), claimed_at = null
      where id = ${args.ingestionId}::uuid`);
    await logRevision(tx, ing.base_id, "ingestion", ing.id, args.decision, args.reviewNote ?? "", sub, null, null, ing.id);
    return { status: newStatus };
  });
}

// ── Verbe digest : delta déterministe de l'org sur N jours (CDC §9, 0 LLM serveur) ──
export function v3Digest(sub: string, args: { base?: string; sinceDays?: number }): Promise<Digest> {
  return withCurrentSub(sub, async (tx) => {
    const baseId = await resolveBaseId(tx, args.base);
    await assertAccess(sub, { baseId }); // membre de l'org — sinon fuite digest cross-org via UUID connu
    const orgId = await orgIdOfBase(tx, baseId);
    return runDigest(orgId, { sinceDays: args.sinceDays });
  });
}

// ── Verbe share : par page (visibilité OU grant user) ─────────────────────────
export function v3Share(
  sub: string, args: { pageRef: string; to: { visibility: string } | { user: string; mode: string } },
): Promise<{ ok: true; resolved?: { userId: string; email: string | null; pending: boolean; provisioned: boolean } }> {
  return withCurrentSub(sub, async (tx) => {
    if ("visibility" in args.to) {
      await assertCanSetVisibility(sub, args.pageRef, args.to.visibility);
      await tx.execute(sql`update mem_pages set visibility = ${args.to.visibility}::mem_page_visibility where id = ${args.pageRef}::uuid`);
      return { ok: true as const };
    }
    await assertAccess(sub, { pageId: args.pageRef }, { write: true });
    const page = one<{ base_id: string; base_name: string }>(await tx.execute(sql`
      select b.id as base_id, b.name as base_name from mem_pages p
      join mem_bases b on b.id = p.base_id where p.id = ${args.pageRef}::uuid`));
    const raw = args.to.user.trim();
    const mode = args.to.mode;
    // `user` = email OU sub. Un email résout via le flux d'invitation partagé
    // (provisionne le compte au besoin + envoie l'invitation) — comble le manque
    // email→sub commun aux grants de partage de page (issue #71). La RÉVOCATION
    // (mode:'none') ne provisionne jamais : elle résout l'email sans créer de compte.
    let userId = raw;
    let provisioned = false;
    if (raw.includes("@")) {
      if (mode === "none") {
        userId = await subForEmail(raw);
      } else {
        await assertWithinLimit(sub, "invite"); // peut provisionner + envoyer un mail
        const acc = await ensureAccount(raw, { scope: "workspace", targetName: page.base_name, inviterSub: sub });
        userId = acc.sub;
        provisioned = acc.provisioned;
      }
    }
    if (mode === "none") {
      // Révocation : `none` n'existe pas dans l'enum DB → on SUPPRIME le grant.
      await tx.execute(sql`
        delete from mem_page_grants where page_id = ${args.pageRef}::uuid and user_id = ${userId}`);
    } else {
      await tx.execute(sql`
        insert into mem_page_grants (base_id, page_id, user_id, mode, created_by)
        values (${page.base_id}, ${args.pageRef}::uuid, ${userId}, ${mode}::mem_grant_mode, ${sub})
        on conflict (page_id, user_id) do update set mode = excluded.mode`);
    }
    const info = (await emailsFor([userId])).get(userId);
    return {
      ok: true as const,
      resolved: {
        userId,
        email: info?.email ?? (raw.includes("@") ? raw : null),
        pending: info?.pending ?? provisioned,
        provisioned,
      },
    };
  });
}

