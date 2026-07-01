/**
 * V3 — recherche PAGE-CHUNKÉE (issue #57, contrat mcp-contract.v3.ts).
 *
 * savoir = pgvector(mem_page_chunks) + FTS(mem_pages.body_fts) fusionnés en RRF →
 * page + passage. sources = FTS verbatim sur mem_sources, remontée via sa page.
 * Restreint aux pages accessibles (mêmes prédicats que la policy RLS, mais EXPLICITES
 * dans le WHERE — le runtime Edge se connecte en owner et contourne la RLS ; appliquer
 * la RLS au-dessus d'un kNN HNSW est précisément le piège qu'on évite).
 *
 * Fichier SÉPARÉ de search.ts (v2, bloc-centré, encore vivant) : zéro couplage, le
 * cutover se fera en basculant les Edge functions de l'un vers l'autre.
 */
import { sql } from "drizzle-orm";
import type { SearchHit, EntityRef, Search as ContractSearch } from "../../../server/src/mcp-contract.v3.ts";

// db chargé PARESSEUSEMENT (même pattern qu'entities.ts) : importer ce module ne doit
// PAS exiger DATABASE_URL — seul l'appel réel à search() ouvre la connexion. Permet à
// `deno test` de charger le module (puis skip si pas de DB) sans DATABASE_URL.
let _db: typeof import("./db.v3.ts").db | null = null;
async function getDb() {
  if (!_db) _db = (await import("./db.v3.ts")).db;
  return _db;
}

/** Interface du lot embedding (Mistral/1024) — injectée (pas de module embed v3 encore). */
export type EmbedTexts = (texts: string[]) => Promise<number[][] | null>;
/** Identité du requérant (pose `request.jwt.claims` pour `accessible_*_ids()`). */
export interface SearchContext { sub: string | null }
export interface SearchDeps { embedTexts: EmbedTexts }

type V3SearchArgs = Parameters<ContractSearch>[0];
type Tx = Parameters<Parameters<typeof import("./db.v3.ts").db.transaction>[0]>[0];

const RRF_K_V3 = 60;
const SEM_OVERFETCH = 5; // sur-récupère côté kNN avant filtre d'accès (recall sous post-filtre)
const HEADLINE = "StartSel=«, StopSel=», MaxFragments=2, MaxWords=28, MinWords=6";
const ENTITIES_PER_HIT = 6;

// Prédicat d'ÉNUMÉRATION (≠ lecture par lien). La recherche LISTE des pages : elle ne
// doit PAS surfacer les pages `public` d'AUTRES orgs (#56 les expose pour le get-par-lien,
// jamais pour l'énumération). On ne garde donc que les pages à mode de lecture EFFECTIF
// (membre / grant / héritage) = exactement l'ensemble `accessible_page_ids()` de #56,
// en forme PER-ROW `page_read_mode(p.id) IS NOT NULL` (planner-friendly sous HNSW : pas de
// matérialisation du set complet). Alias de table figé = `p`.
// NB #56 : `is_page_accessible` (= public-par-lien inclus) arme la RLS ; il NE convient PAS
// au WHERE de search (l'en-tête d'access.v3.ts affirme le contraire → à corriger côté #56).
// Un wrapper nommé `is_page_enumerable(uuid)` (= `page_read_mode($1) IS NOT NULL`) côté #56
// rendrait ceci plus lisible — on basculerait alors sur l'appel nommé.
const ENUMERABLE = sql`page_read_mode(p.id) IS NOT NULL`;

const toVecLit = (v: number[]) => `[${v.join(",")}]`;

/** Filtres communs sur `p` (plage occurred_at + restriction au sous-arbre `filters.page`). */
function pageFilters(filters: V3SearchArgs["filters"], subtree: string[] | null) {
  const c = [];
  if (filters?.occurredFrom) c.push(sql`p.occurred_at >= ${filters.occurredFrom}`);
  if (filters?.occurredTo) c.push(sql`p.occurred_at <= ${filters.occurredTo}`);
  if (subtree) {
    c.push(subtree.length ? sql`p.id IN (${sql.join(subtree.map((id) => sql`${id}`), sql`, `)})` : sql`false`);
  }
  return c.length ? sql.join(c, sql` AND `) : sql`true`;
}

/** `filters.page` → ids de la page + tous ses descendants (un seul CTE récursif). */
async function subtreeIds(tx: Tx, pageId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE sub AS (
      SELECT id FROM mem_pages WHERE id = ${pageId}
      UNION ALL
      SELECT c.id FROM mem_pages c JOIN sub ON c.parent_id = sub.id)
    SELECT id FROM sub`);
  return [...rows].map((r) => r.id);
}

type PageRow = { page_id: string; title: string; description: string; occurred_at: string | Date | null; passage: string };

async function lexicalPages(tx: Tx, q: string, k: number, filt: ReturnType<typeof pageFilters>): Promise<PageRow[]> {
  const rows = await tx.execute<PageRow>(sql`
    SELECT p.id AS page_id, p.title, p.description, p.occurred_at,
           ts_headline('french_unaccent', p.body, query, ${HEADLINE}) AS passage
    FROM mem_pages p, websearch_to_tsquery('french_unaccent', ${q}) query
    WHERE p.status = 'active' AND p.body_fts @@ query AND ${ENUMERABLE} AND ${filt}
    ORDER BY ts_rank(p.body_fts, query) DESC
    LIMIT ${k}`);
  return [...rows];
}

async function semanticPages(tx: Tx, vec: number[], k: number, filt: ReturnType<typeof pageFilters>): Promise<PageRow[]> {
  const lit = toVecLit(vec);
  // Sur-récupère puis dédup par page (plusieurs chunks d'une même page) — on garde le
  // meilleur (1er = plus proche). Le filtre d'accès est dans le WHERE, pas en RLS.
  const rows = await tx.execute<PageRow>(sql`
    SELECT c.page_id, p.title, p.description, p.occurred_at, c.content AS passage
    FROM mem_page_chunks c JOIN mem_pages p ON p.id = c.page_id
    WHERE c.embedding IS NOT NULL AND p.status = 'active' AND ${ENUMERABLE} AND ${filt}
    ORDER BY c.embedding <=> ${lit}::halfvec
    LIMIT ${k * SEM_OVERFETCH}`);
  const seen = new Set<string>();
  const out: PageRow[] = [];
  for (const r of rows) {
    if (seen.has(r.page_id)) continue;
    seen.add(r.page_id);
    out.push(r);
    if (out.length >= k) break;
  }
  return out;
}

async function sourcePages(tx: Tx, q: string, k: number, filt: ReturnType<typeof pageFilters>): Promise<PageRow[]> {
  // FTS verbatim sur la source, remontée via SA page (mem_page_sources). Dédup par page.
  const rows = await tx.execute<PageRow>(sql`
    SELECT ps.page_id, p.title, p.description, p.occurred_at,
           ts_headline('french_unaccent', coalesce(s.content, s.title), query, ${HEADLINE}) AS passage,
           ts_rank(s.fts, query) AS rank
    FROM mem_sources s
    JOIN mem_page_sources ps ON ps.source_id = s.id
    JOIN mem_pages p ON p.id = ps.page_id, websearch_to_tsquery('french_unaccent', ${q}) query
    WHERE s.fts @@ query AND p.status = 'active' AND ${ENUMERABLE} AND ${filt}
    ORDER BY rank DESC
    LIMIT ${k * SEM_OVERFETCH}`);
  const seen = new Set<string>();
  const out: PageRow[] = [];
  for (const r of rows) {
    if (seen.has(r.page_id)) continue;
    seen.add(r.page_id);
    out.push(r);
    if (out.length >= k) break;
  }
  return out;
}

/** Entités saillantes par page (mention la plus confiante d'abord), top-N. */
async function entitiesByPage(tx: Tx, pageIds: string[]): Promise<Map<string, EntityRef[]>> {
  const map = new Map<string, EntityRef[]>();
  if (!pageIds.length) return map;
  const rows = await tx.execute<{ page_id: string; id: string; type: EntityRef["type"]; label: string }>(sql`
    SELECT m.page_id, e.id, e.type, e.canonical_label AS label
    FROM mem_mentions m JOIN mem_entities e ON e.id = m.entity_id
    WHERE m.page_id IN (${sql.join(pageIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY m.confidence DESC NULLS LAST`);
  for (const r of rows) {
    const list = map.get(r.page_id) ?? [];
    if (list.length < ENTITIES_PER_HIT) list.push({ id: r.id, type: r.type, label: r.label });
    map.set(r.page_id, list);
  }
  return map;
}

// Accumulateur RRF. passage : priorité lexical-page > source > sémantique (le headline
// lexical est centré sur la requête ; le chunk sémantique est brut).
type Fused = {
  pageId: string; title: string; description: string; occurredAt: string | null;
  passage: string; passagePrio: number; score: number; matchedBy: Set<"semantic" | "lexical">;
};
const PASSAGE_PRIO = { lexical: 3, source: 2, semantic: 1 } as const;

function toIso(v: string | Date | null): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Recherche v3 page-chunkée. Renvoie exactement `SearchHit[]` (contrat).
 * `ctx`/`deps` sont fournis par l'adaptateur MCP/REST (le contrat `Search` ne porte ni
 * identité ni embed) — le type de RETOUR, lui, est celui du contrat.
 */
export async function search(ctx: SearchContext, args: V3SearchArgs, deps: SearchDeps): Promise<SearchHit[]> {
  const limit = Math.min(Math.max(args.limit ?? 8, 1), 50);
  const scope = args.scope ?? "savoir";
  const q = args.q?.trim();
  if (!q) return [];

  // L'embedding de requête : best-effort. Indisponible → on dégrade en lexical (visible
  // via matchedBy, jamais de fallback silencieux). Hors transaction (appel réseau).
  const needSem = scope !== "sources";
  const vec = needSem ? (await deps.embedTexts([q]).catch(() => null))?.[0] ?? null : null;

  return await (await getDb()).transaction(async (tx) => {
    // Identité → GUC transaction-local (pooler-safe) pour `accessible_*_ids()`.
    if (ctx.sub) {
      await tx.execute(sql`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: ctx.sub })}, true)`);
    }

    // filters.page → sous-arbre (vide ⇒ page introuvable ⇒ aucun résultat).
    let subtree: string[] | null = null;
    if (args.filters?.page) {
      subtree = await subtreeIds(tx, args.filters.page);
      if (!subtree.length) return [];
    }
    const filt = pageFilters(args.filters, subtree);

    const [lex, sem, src] = await Promise.all([
      scope !== "sources" ? lexicalPages(tx, q, limit, filt) : Promise.resolve<PageRow[]>([]),
      vec ? semanticPages(tx, vec, limit, filt) : Promise.resolve<PageRow[]>([]),
      scope !== "savoir" ? sourcePages(tx, q, limit, filt) : Promise.resolve<PageRow[]>([]),
    ]);

    const fused = new Map<string, Fused>();
    const addRegime = (rows: PageRow[], tag: "semantic" | "lexical", prio: number) => {
      rows.forEach((r, i) => {
        const cur = fused.get(r.page_id);
        const rrf = 1 / (RRF_K_V3 + i + 1);
        if (cur) {
          cur.score += rrf;
          cur.matchedBy.add(tag);
          if (prio > cur.passagePrio) { cur.passage = r.passage; cur.passagePrio = prio; }
        } else {
          fused.set(r.page_id, {
            pageId: r.page_id, title: r.title, description: r.description, occurredAt: toIso(r.occurred_at),
            passage: r.passage, passagePrio: prio, score: rrf, matchedBy: new Set([tag]),
          });
        }
      });
    };
    addRegime(lex, "lexical", PASSAGE_PRIO.lexical);
    addRegime(sem, "semantic", PASSAGE_PRIO.semantic);
    addRegime(src, "lexical", PASSAGE_PRIO.source); // sources = régime lexical

    const top = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    const ents = await entitiesByPage(tx, top.map((h) => h.pageId));

    return top.map((h) => ({
      pageId: h.pageId,
      title: h.title,
      description: h.description,
      passage: h.passage,
      occurredAt: h.occurredAt,
      score: Math.round(h.score * 10000) / 10000,
      matchedBy: (["semantic", "lexical"] as const).filter((m) => h.matchedBy.has(m)),
      entities: ents.get(h.pageId) ?? [],
    }));
  });
}
