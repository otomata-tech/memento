/**
 * V3 — Lint déterministe du graphe (#63, CDC §8). SQL pur, **0 LLM**, scopé org
 * (1 base/org). Détecte les défauts de santé et, en option, **réalimente la file
 * de revue d'entités** (`entity_review`) avec les quasi-doublons trouvés.
 *
 * Lançable à la demande (verbe/référent) ou en job planifié. Import db paresseux
 * (convention v3) → le module charge sans DATABASE_URL.
 */
import { sql } from "drizzle-orm";

let _db: typeof import("./db.v3.ts").db | null = null;
async function getDb() {
  if (!_db) _db = (await import("./db.v3.ts")).db;
  return _db;
}

const ENTITY_DUP_THRESHOLD = 0.7; // trigram sur normalised_label (même famille que la résolution)
const PAGE_DUP_COSINE = 0.95; // chunks quasi-identiques entre deux pages

export interface LintReport {
  orgId: string;
  score: number; // 0–100 (100 = sain)
  pagesNoDescription: number;
  emptyLeafPages: number; // body vide, sans enfant, sans source → probable résidu
  pageNearDuplicates: number; // paires de pages aux chunks quasi-identiques
  entityStubs: number; // is_stub=true (non promues, < 2 mentions)
  entityNearDuplicates: number; // paires (même type) trigram > seuil, hors revue en cours
  reviewSuggestionsCreated: number; // si feedReview
}

async function count(db: Awaited<ReturnType<typeof getDb>>, q: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.execute<{ n: number }>(q);
  return Number(rows[0]?.n ?? 0);
}

/** Lint d'une org. `feedReview` insère les quasi-doublons d'entités en `entity_review`. */
export async function runLint(orgId: string, opts: { feedReview?: boolean } = {}): Promise<LintReport> {
  const db = await getDb();

  const pagesNoDescription = await count(db, sql`
    select count(*)::int n from mem_pages p join mem_bases b on b.id = p.base_id
    where b.org_id = ${orgId} and p.status = 'active' and coalesce(p.description, '') = ''`);

  const emptyLeafPages = await count(db, sql`
    select count(*)::int n from mem_pages p join mem_bases b on b.id = p.base_id
    where b.org_id = ${orgId} and p.status = 'active' and coalesce(p.body, '') = ''
      and not exists (select 1 from mem_pages c where c.parent_id = p.id)
      and not exists (select 1 from mem_page_sources ps where ps.page_id = p.id)`);

  const pageNearDuplicates = await count(db, sql`
    select count(*)::int n from (
      select distinct least(c1.page_id, c2.page_id) a, greatest(c1.page_id, c2.page_id) b
      from mem_page_chunks c1
      join mem_pages p1 on p1.id = c1.page_id
      join mem_bases bb on bb.id = p1.base_id and bb.org_id = ${orgId}
      join mem_page_chunks c2 on c2.page_id <> c1.page_id
        and c1.embedding is not null and c2.embedding is not null
        and (1 - (c1.embedding <=> c2.embedding)) > ${PAGE_DUP_COSINE}
    ) pairs`);

  const entityStubs = await count(db, sql`
    select count(*)::int n from mem_entities where org_id = ${orgId} and is_stub = true`);

  // Paires de quasi-doublons d'entités (même type), pas déjà en revue pending.
  const dupRows = await db.execute<{ a: string; b: string; score: number }>(sql`
    select e1.id a, e2.id b, similarity(e1.normalised_label, e2.normalised_label) score
    from mem_entities e1
    join mem_entities e2 on e2.org_id = e1.org_id and e2.type = e1.type and e1.id < e2.id
      and similarity(e1.normalised_label, e2.normalised_label) > ${ENTITY_DUP_THRESHOLD}
    where e1.org_id = ${orgId}
      and not exists (
        select 1 from mem_entity_reviews r where r.org_id = ${orgId} and r.status = 'pending'
          and least(r.entity_keep, r.entity_drop) = least(e1.id, e2.id)
          and greatest(r.entity_keep, r.entity_drop) = greatest(e1.id, e2.id))`);
  const entityNearDuplicates = dupRows.length;

  let reviewSuggestionsCreated = 0;
  if (opts.feedReview && dupRows.length) {
    for (const d of dupRows) {
      // keep = celle qui a le plus de mentions (égalité → a) ; drop = l'AUTRE (garanti ≠ keep).
      const mc = await db.execute<{ id: string; c: number }>(sql`
        select id, (select count(*)::int from mem_mentions where entity_id = e.id) c
        from mem_entities e where e.id in (${d.a}::uuid, ${d.b}::uuid)`);
      const ca = Number(mc.find((m) => m.id === d.a)?.c ?? 0);
      const cb = Number(mc.find((m) => m.id === d.b)?.c ?? 0);
      const keep = cb > ca ? d.b : d.a;
      const drop = keep === d.a ? d.b : d.a;
      await db.execute(sql`
        insert into mem_entity_reviews (org_id, entity_keep, entity_drop, score, method, created_by)
        values (${orgId}, ${keep}, ${drop}, ${d.score}, 'lint', 'lint')`);
      reviewSuggestionsCreated++;
    }
  }

  // Score : 100 − pénalités pondérées (borné).
  const penalty =
    pagesNoDescription * 2 + emptyLeafPages * 3 + entityStubs * 1 +
    entityNearDuplicates * 2 + pageNearDuplicates * 5;
  const score = Math.max(0, 100 - Math.min(100, penalty));

  return {
    orgId, score, pagesNoDescription, emptyLeafPages, pageNearDuplicates,
    entityStubs, entityNearDuplicates, reviewSuggestionsCreated,
  };
}
