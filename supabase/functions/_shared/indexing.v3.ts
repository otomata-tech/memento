/**
 * V3 — indexation sémantique d'une page (#62). (Re)découpe le texte en chunks,
 * les vectorise (embed.v3 / Mistral 1024) et upsert `mem_page_chunks`.
 *
 * Branchée best-effort ASYNC dans apply() (mcp/v3.ts), à côté de la résolution
 * d'entités — même posture : la page est écrite d'abord (FTS lexical opérationnel via
 * `body_fts`), l'index sémantique se complète après. Si l'embedding est indisponible
 * (clé absente / API en échec → embedTexts null), les chunks sont écrits SANS embedding
 * (le kNN les ignore ; un backfill rattrape) — jamais de fallback caché.
 *
 * Import paresseux de db (convention v3) → le module charge sans DATABASE_URL ni clé.
 */
import { sql } from "drizzle-orm";
import { EMBEDDING_MODEL, embedTexts, toVec } from "./embed.v3.ts";

let _db: typeof import("./db.ts").db | null = null;
async function getDb() {
  if (!_db) _db = (await import("./db.ts")).db;
  return _db;
}

const MAX_CHUNK_CHARS = 1500; // fenêtre de repli pour une section trop longue

/**
 * Découpe un texte markdown en chunks : une section par titre (`#`…`######`), puis
 * fenêtrage des sections trop longues. Pur, déterministe, unit-testable.
 */
export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const t = (text ?? "").trim();
  if (!t) return [];
  const sections: string[] = [];
  let cur: string[] = [];
  for (const line of t.split("\n")) {
    if (/^#{1,6}\s/.test(line) && cur.length) { sections.push(cur.join("\n").trim()); cur = []; }
    cur.push(line);
  }
  if (cur.length) sections.push(cur.join("\n").trim());

  const chunks: string[] = [];
  for (const s of sections) {
    if (!s) continue;
    if (s.length <= maxChars) { chunks.push(s); continue; }
    for (let i = 0; i < s.length; i += maxChars) chunks.push(s.slice(i, i + maxChars));
  }
  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * (Ré)indexe une page : remplace TOUS ses chunks (re-chunk à chaque update). Best-effort
 * — l'appelant (apply) l'exécute en non bloquant et avale l'erreur. La transaction garde
 * la cohérence (delete + inserts atomiques) ; embedding null si embedTexts indisponible.
 */
export async function indexPage(pageId: string, text: string): Promise<void> {
  const chunks = chunkText(text);
  const db = await getDb();
  if (!chunks.length) {
    await db.execute(sql`delete from mem_page_chunks where page_id = ${pageId}::uuid`);
    return;
  }
  const vecs = await embedTexts(chunks); // number[][] | null (best-effort)
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from mem_page_chunks where page_id = ${pageId}::uuid`);
    for (let i = 0; i < chunks.length; i++) {
      const v = vecs?.[i];
      const emb = v ? sql`${toVec(v)}::halfvec` : sql`null`;
      await tx.execute(sql`
        insert into mem_page_chunks (page_id, idx, content, model_version, embedding)
        values (${pageId}::uuid, ${i}, ${chunks[i]}, ${EMBEDDING_MODEL}, ${emb})`);
    }
  });
}
