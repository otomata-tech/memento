/**
 * Boucle propose-valide (Lot 5). Cf. spec §5.4 / §6.
 *
 * Un agent propose un change-set (`stage_changes`) → `MemIngestion` PROPOSED, rien n'est muté.
 * Un humain revoit (`get`/`list`) puis applique tout ou un sous-ensemble (`apply`) ou rejette
 * (`reject`). À l'application, chaque op exécute le verbe d'écriture correspondant et journalise
 * une `MemRevision` liée à l'`ingestionId` (réversible via before/after).
 *
 * Garde-fou : une op de classe CONTRADICT n'est JAMAIS auto-appliquée — il faut l'accepter
 * explicitement via `acceptIds`. Garde-fou scoping : la cible de chaque op doit appartenir au
 * workspace de l'ingestion (pas de mutation cross-workspace via un change-set forgé).
 *
 * L'état de chaque change (applied/error) est persisté dans le `proposal` jsonb : une ingestion
 * PARTIAL peut être ré-appliquée pour traiter les ops restantes.
 */
import { and, desc, eq, isNull, lt, notInArray, or } from "drizzle-orm";
import { db, ingestions, workspaces } from "./db.ts";
import { loopUrl } from "./urls.ts";
import { resolveWorkspaceId } from "./access.ts";
import { nearDuplicates } from "./semantic.ts";
import {
  addDocument, addBlock, updateBlock, setBlockType, deleteBlock,
  attachSource, detachSource, verifyBlock, moveBlock, linkBlocks, unlinkBlocks, deprecateDocument,
  type WriteCtx,
} from "./write.ts";

const CLASSES = ["CONFIRM", "ENRICH", "CONTRADICT", "OBSOLETE"];

type Handler = (payload: any, actor: string, ctx: WriteCtx) => Promise<any>;
const OPS: Record<string, Handler> = {
  add_document: addDocument, add_block: addBlock, update_block: updateBlock,
  set_block_type: setBlockType, delete_block: deleteBlock,
  attach_source: attachSource, detach_source: detachSource,
  verify_block: verifyBlock, move_block: moveBlock,
  link_blocks: linkBlocks, unlink: unlinkBlocks, deprecate_document: deprecateDocument,
};

// Cible primaire de chaque op → pour vérifier qu'elle vit dans le workspace de l'ingestion.
const TARGET: Record<string, { kind: "section" | "document" | "block" | "link"; field: string }> = {
  add_document: { kind: "section", field: "sectionId" },
  add_block: { kind: "document", field: "documentId" },
  update_block: { kind: "block", field: "id" },
  set_block_type: { kind: "block", field: "id" },
  delete_block: { kind: "block", field: "id" },
  verify_block: { kind: "block", field: "id" },
  attach_source: { kind: "block", field: "blockId" },
  detach_source: { kind: "block", field: "blockId" },
  move_block: { kind: "block", field: "id" },
  link_blocks: { kind: "block", field: "fromId" },
  unlink: { kind: "link", field: "linkId" },
  deprecate_document: { kind: "document", field: "id" },
};

type Feedback = { author: string; authorKind: string; body: string; at: string };
type Change = {
  id: string; op: string; class: string;
  target: string | null; rationale: string | null; payload: Record<string, unknown>;
  applied: boolean; appliedAt?: string; error?: string;
  feedback?: Feedback[]; // retours de revue humains (ping-pong) ; lus par l'agent au prochain tour
  edited?: boolean; editedBy?: string; // payload retouché par un humain avant application
};

async function targetWorkspace(op: string, payload: Record<string, unknown>): Promise<string | null> {
  const t = TARGET[op];
  if (!t) return null;
  const id = payload[t.field];
  if (typeof id !== "string") return null;
  return resolveWorkspaceId({ id, kind: t.kind });
}

function counts(changes: Change[]) {
  const byClass: Record<string, number> = {};
  let applied = 0, pending = 0, errored = 0;
  for (const c of changes) {
    byClass[c.class] = (byClass[c.class] ?? 0) + 1;
    if (c.applied) applied++; else pending++;
    if (c.error) errored++;
  }
  return { total: changes.length, applied, pending, errored, byClass };
}

function present(row: typeof ingestions.$inferSelect, slug?: string) {
  const changes = (row.proposal as Change[]) ?? [];
  return {
    id: row.id, workspace: slug, workspaceId: row.workspaceId,
    url: slug ? loopUrl(slug, row.id) : null,
    title: row.title, summary: row.summary, status: row.status,
    reviewNote: row.reviewNote ?? null,
    sourceId: row.sourceId, createdBy: row.createdBy, createdAt: row.createdAt,
    decidedBy: row.decidedBy, decidedAt: row.decidedAt,
    counts: counts(changes), changes,
  };
}

// Valide les ops/classes et matérialise les changes (id stable par change).
function buildChanges(input: Array<{ op: string; class?: string; target?: string; rationale?: string; payload?: Record<string, unknown> }>): Change[] {
  return input.map((c) => {
    if (!OPS[c.op]) throw new Error(`op inconnue: ${c.op} (attendu: ${Object.keys(OPS).join(", ")})`);
    if (c.class && !CLASSES.includes(c.class)) throw new Error(`class invalide: ${c.class} (attendu: ${CLASSES.join(", ")})`);
    return {
      id: crypto.randomUUID(), op: c.op, class: c.class ?? "ENRICH",
      target: c.target ?? null, rationale: c.rationale ?? null,
      payload: c.payload ?? {}, applied: false,
    };
  });
}

// ── Verbes ──────────────────────────────────────────────────────────────────
export async function stageChanges(
  args: {
    workspace: string; sourceId?: string; title: string; summary?: string; clientKey?: string;
    changes: Array<{ op: string; class?: string; target?: string; rationale?: string; payload?: Record<string, unknown> }>;
  },
  actor: string,
) {
  const [ws] = await db.select({ id: workspaces.id, slug: workspaces.slug }).from(workspaces)
    .where(eq(workspaces.slug, args.workspace)).limit(1);
  if (!ws) throw new Error(`Workspace introuvable: ${args.workspace}`);
  if (!args.changes?.length) throw new Error("`changes` vide");

  // Idempotence (#44) + supersession (ping-pong) : même clientKey, même workspace.
  if (args.clientKey) {
    const [dup] = await db.select().from(ingestions)
      .where(and(eq(ingestions.workspaceId, ws.id), eq(ingestions.clientKey, args.clientKey))).limit(1);
    if (dup) {
      // Clôturée (APPLIED/REJECTED) → no-op idempotent (retry sûr).
      if (dup.status === "APPLIED" || dup.status === "REJECTED") {
        return { ...present(dup, ws.slug), deduplicated: true };
      }
      // Ouverte (PROPOSED/PARTIAL/CHANGES_REQUESTED) → l'agent re-propose après revue :
      // on remplace le change-set, on rouvre en PROPOSED et on efface l'état de décision.
      const next = buildChanges(args.changes);
      const [upd] = await db.update(ingestions).set({
        title: args.title, summary: args.summary ?? "", sourceId: args.sourceId ?? dup.sourceId,
        proposal: next, status: "PROPOSED", reviewNote: null, decidedBy: null, decidedAt: null,
      }).where(eq(ingestions.id, dup.id)).returning();
      return { ...present(upd, ws.slug), superseded: true };
    }
  }

  const changes = buildChanges(args.changes);

  const [row] = await db.insert(ingestions).values({
    workspaceId: ws.id, sourceId: args.sourceId ?? null, title: args.title,
    summary: args.summary ?? "", proposal: changes, status: "PROPOSED", createdBy: actor,
    clientKey: args.clientKey ?? null,
  }).onConflictDoNothing({ target: [ingestions.workspaceId, ingestions.clientKey] }).returning();
  if (!row) return stageChanges(args, actor); // course perdue check/insert → relit l'existante

  // Signal anti-doublon (#44), best-effort : pour chaque add_block proposé, les blocs
  // quasi identiques déjà en base. Le serveur signale, l'agent et le relecteur jugent.
  const dupChecks = await Promise.all(
    changes
      .filter((c) => c.op === "add_block" && typeof c.payload.content === "string")
      .slice(0, 20)
      .map(async (c) => ({
        changeId: c.id,
        similar: await nearDuplicates(ws.id, { text: c.payload.content as string }),
      })),
  );
  const similarExisting = dupChecks.filter((d) => d.similar.length);
  return { ...present(row, ws.slug), ...(similarExisting.length ? { similarExisting } : {}) };
}

async function fetchWithSlug(id: string) {
  const [row] = await db.select().from(ingestions).where(eq(ingestions.id, id)).limit(1);
  if (!row) throw new Error(`Ingestion introuvable: ${id}`);
  const [ws] = await db.select({ slug: workspaces.slug }).from(workspaces)
    .where(eq(workspaces.id, row.workspaceId)).limit(1);
  return { row, slug: ws?.slug };
}

export async function getIngestion(id: string) {
  const { row, slug } = await fetchWithSlug(id);
  return present(row, slug);
}

export async function listIngestions(args: { workspace: string; status?: string }) {
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces)
    .where(eq(workspaces.slug, args.workspace)).limit(1);
  if (!ws) throw new Error(`Workspace introuvable: ${args.workspace}`);
  const conds = [eq(ingestions.workspaceId, ws.id)];
  if (args.status) conds.push(eq(ingestions.status, args.status as any));
  const rows = await db.select().from(ingestions).where(and(...conds)).orderBy(desc(ingestions.createdAt));
  return {
    workspace: args.workspace, count: rows.length,
    ingestions: rows.map((r) => ({
      id: r.id, url: loopUrl(args.workspace, r.id),
      title: r.title, status: r.status, sourceId: r.sourceId,
      createdBy: r.createdBy, createdAt: r.createdAt, counts: counts((r.proposal as Change[]) ?? []),
    })),
  };
}

export async function applyIngestion(
  args: { id: string; acceptIds?: string[]; edits?: Array<{ id: string; payload: Record<string, unknown> }> },
  actor: string,
) {
  // Claim atomique (#40) : réserve l'ingestion AVANT tout travail. Un seul UPDATE
  // gagne la course ; un apply concurrent ou rejoué (retry transport en vol)
  // obtient 0 ligne → no-op idempotent, plus de double exécution du change-set.
  const claimCutoff = new Date(Date.now() - 5 * 60_000); // claim plus vieux = apply crashé → ré-ouvrable
  const [claimed] = await db.update(ingestions)
    .set({ claimedAt: new Date() })
    .where(and(
      eq(ingestions.id, args.id),
      notInArray(ingestions.status, ["APPLIED", "REJECTED"]),
      or(isNull(ingestions.claimedAt), lt(ingestions.claimedAt, claimCutoff)),
    ))
    .returning({ id: ingestions.id });
  if (!claimed) {
    // Déjà clôturée, ou un autre apply tient le claim → no-op, on renvoie l'état courant.
    const { row, slug } = await fetchWithSlug(args.id);
    return {
      id: args.id, workspace: slug, status: row.status,
      counts: counts((row.proposal as Change[]) ?? []), results: [], noop: true,
    };
  }
  const { row, slug } = await fetchWithSlug(args.id);
  const changes = (row.proposal as Change[]) ?? [];
  const accept = args.acceptIds ? new Set(args.acceptIds) : null;
  const edits = new Map((args.edits ?? []).map((e) => [e.id, e.payload]));
  const results: Array<{ id: string; status: string; reason?: string; error?: string }> = [];

  for (const c of changes) {
    if (c.applied) { results.push({ id: c.id, status: "already" }); continue; }
    if (accept && !accept.has(c.id)) { results.push({ id: c.id, status: "skipped" }); continue; }
    // CONTRADICT jamais auto-appliqué : exige une acceptation explicite par id.
    if (c.class === "CONTRADICT" && !(accept && accept.has(c.id))) {
      results.push({ id: c.id, status: "held", reason: "CONTRADICT requiert acceptation explicite (acceptIds)" });
      continue;
    }
    // Édition humaine en place : on fusionne le payload retouché avant d'exécuter l'op
    // (la MemRevision tracera donc le contenu validé, pas la proposition brute de l'agent).
    const edit = edits.get(c.id);
    if (edit) { c.payload = { ...c.payload, ...edit }; c.edited = true; c.editedBy = actor; }
    try {
      const wsId = await targetWorkspace(c.op, c.payload);
      if (wsId !== row.workspaceId) throw new Error("cible hors du workspace de l'ingestion");
      await OPS[c.op](c.payload, actor, { ingestionId: row.id });
      c.applied = true; c.appliedAt = new Date().toISOString(); delete c.error;
      results.push({ id: c.id, status: "applied" });
    } catch (e) {
      c.error = e instanceof Error ? e.message : String(e);
      results.push({ id: c.id, status: "error", error: c.error });
    }
  }

  const status = changes.some((c) => !c.applied) ? "PARTIAL" : "APPLIED";
  await db.update(ingestions)
    // claimedAt: null → libère le verrou (#40) ; un re-apply légitime d'un PARTIAL pourra reprendre.
    .set({ proposal: changes, status, decidedBy: actor, decidedAt: new Date(), claimedAt: null })
    .where(eq(ingestions.id, args.id));
  return { id: args.id, workspace: slug, status, counts: counts(changes), results };
}

export async function rejectIngestion(args: { id: string; reason?: string }, actor: string) {
  const { row } = await fetchWithSlug(args.id);
  if (row.status === "APPLIED" || row.status === "REJECTED") {
    throw new Error(`ingestion déjà clôturée (${row.status})`);
  }
  await db.update(ingestions)
    .set({ status: "REJECTED", decidedBy: actor, decidedAt: new Date() })
    .where(eq(ingestions.id, args.id));
  return { id: args.id, status: "REJECTED", reason: args.reason ?? null };
}

/**
 * Renvoie une ingestion à l'agent pour révision (ping-pong de revue). Attache le feedback
 * humain par changement (`items[].changeId`) et/ou une note globale (`note` ou items sans
 * changeId), passe en CHANGES_REQUESTED. L'agent relit via get/list puis re-propose avec le
 * même `clientKey` (→ supersession). Rien n'est muté dans la KB.
 */
export async function requestChanges(
  args: { id: string; note?: string; items?: Array<{ changeId?: string; body: string }> },
  actor: string,
) {
  const { row, slug } = await fetchWithSlug(args.id);
  if (row.status === "APPLIED" || row.status === "REJECTED") {
    throw new Error(`ingestion déjà clôturée (${row.status})`);
  }
  const changes = (row.proposal as Change[]) ?? [];
  const at = new Date().toISOString();
  const items = args.items ?? [];
  let attached = 0;
  for (const it of items) {
    if (!it.body?.trim() || !it.changeId) continue;
    const target = changes.find((c) => c.id === it.changeId);
    if (!target) continue; // changeId inconnu → ignoré silencieusement
    (target.feedback ??= []).push({ author: actor, authorKind: "human", body: it.body.trim(), at });
    attached++;
  }
  // Note globale = `note` + tout item sans changeId.
  const general = [
    ...(args.note?.trim() ? [args.note.trim()] : []),
    ...items.filter((it) => !it.changeId && it.body?.trim()).map((it) => it.body.trim()),
  ];
  if (!attached && !general.length) throw new Error("aucun feedback fourni (note ou items)");
  const reviewNote = general.length ? general.join("\n\n") : row.reviewNote;
  await db.update(ingestions)
    .set({ proposal: changes, reviewNote, status: "CHANGES_REQUESTED", decidedBy: actor, decidedAt: new Date() })
    .where(eq(ingestions.id, args.id));
  return { ...present((await fetchWithSlug(args.id)).row, slug), requested: attached, hasNote: general.length > 0 };
}
