/**
 * Mini-bench P95 de la recherche v3 page-chunkée (#57, Done : « pas de piège HNSW×RLS »).
 *
 * Objectif = MESURE, pas verrou : on vérifie que le kNN HNSW + le prédicat d'accès
 * EXPLICITE (public OR accessible_base_ids OR accessible_page_ids) ne s'effondre pas
 * quand le filtre est SÉLECTIF (la plupart des pages invisibles → HNSW doit sur-scanner).
 *
 * Hermétique vis-à-vis du réseau : `embedTexts` est un stub (vecteurs 1024 aléatoires).
 * Nécessite une base v3 migrée. Lancer :
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     deno test --allow-env --allow-net --config supabase/functions/deno.json \
 *       supabase/functions/_shared/search.v3.bench.ts
 * Sans DATABASE_URL → skip (pas un échec).
 */
import postgres from "postgres";
import { type EmbedTexts, search } from "./search.v3.ts";

const DB = Deno.env.get("DATABASE_URL");
const DIM = 1024;
const N_PAGES = 1000; // 20% public (visibles) → filtre d'accès sélectif
const PUBLIC_RATIO = 0.2;
const ITERS = 40;
const P95_CEILING_MS = 2000; // borne de sanité GÉNÉREUSE (mesure, pas verrou)

function randVec(): number[] {
  const v = new Array<number>(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) { v[i] = Math.random() * 2 - 1; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
const vecLit = (v: number[]) => `[${v.join(",")}]`;
const fakeEmbed: EmbedTexts = (texts) => Promise.resolve(texts.map(() => randVec()));

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

Deno.test({
  name: "search v3 — bench P95 (HNSW × filtre d'accès sélectif)",
  ignore: !DB,
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const sql = postgres(DB!, { prepare: false });
  const tag = `bench-${crypto.randomUUID().slice(0, 8)}`;
  try {
    // ── Seed : org + base + membership (bench-user) + N pages (20% public énumérables,
    // 80% private exclues par page_read_mode) + 1 chunk/page (embedding aléatoire) ──
    const [org] = await sql`insert into mem_orgs (slug, name) values (${tag}, ${tag}) returning id`;
    const [base] = await sql`insert into mem_bases (org_id, name) values (${org.id}, ${tag}) returning id`;
    await sql`insert into mem_memberships (org_id, user_id, role) values (${org.id}, 'bench-user', 'member')`;

    const WORDS = ["migration", "pgvector", "doctrine", "entité", "recherche", "page", "embedding", "accès", "mistral", "chunk"];
    for (let i = 0; i < N_PAGES; i++) {
      const vis = Math.random() < PUBLIC_RATIO ? "public" : "private";
      const body = `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${WORDS[(i * 3) % WORDS.length]} note ${i}`;
      const rows = await sql<{ id: string }[]>`
        insert into mem_pages (base_id, title, description, body, visibility)
        values (${base.id}, ${`Page ${i}`}, ${`desc ${i}`}, ${body}, ${vis}::mem_page_visibility) returning id`;
      await sql`insert into mem_page_chunks (page_id, idx, content, model_version, embedding)
                values (${rows[0].id}, 0, ${body}, 'bench', ${vecLit(randVec())}::halfvec)`;
    }
    const [{ npub }] = await sql`select count(*)::int npub from mem_pages p join mem_bases b on b.id=p.base_id where b.org_id=${org.id} and p.visibility='public'`;

    // ── Bench : ITERS recherches hybrides, scope 'savoir', mesure latence ──
    const ctx = { sub: "bench-user" };
    const deps = { embedTexts: fakeEmbed };
    // warmup
    await search(ctx, { q: "migration pgvector", limit: 8 }, deps);
    const times: number[] = [];
    let lastCount = 0;
    for (let i = 0; i < ITERS; i++) {
      const q = `${WORDS[i % WORDS.length]} ${WORDS[(i * 5) % WORDS.length]}`;
      const t0 = performance.now();
      const hits = await search(ctx, { q, limit: 8 }, deps);
      times.push(performance.now() - t0);
      lastCount = hits.length;
      // invariant d'accès : aucune page privée ne doit ressortir
      for (const h of hits) {
        const [row] = await sql`select visibility from mem_pages where id=${h.pageId}`;
        if (row.visibility !== "public") throw new Error(`fuite d'accès : page ${row.visibility} renvoyée`);
      }
    }
    times.sort((a, b) => a - b);
    const p50 = pct(times, 50), p95 = pct(times, 95), max = times[times.length - 1];
    console.log(`\n[bench] ${N_PAGES} pages (${npub} publiques) · ${ITERS} requêtes hybrides · derniers hits=${lastCount}`);
    console.log(`[bench] latence ms  p50=${p50.toFixed(1)}  p95=${p95.toFixed(1)}  max=${max.toFixed(1)}`);

    if (p95 > P95_CEILING_MS) throw new Error(`P95 ${p95.toFixed(0)}ms > plafond sanité ${P95_CEILING_MS}ms — piège HNSW×filtre ?`);
  } finally {
    // cleanup : base cascade (pages→chunks/sources), puis org
    await sql`delete from mem_bases where name=${tag}`;
    await sql`delete from mem_orgs where slug=${tag}`;
    await sql.end();
  }
});
