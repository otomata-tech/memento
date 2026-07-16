/**
 * Test harness de l'indexation sémantique dans apply (#62).
 * Chemin RÉEL apply → indexPage → embed.v3, avec un MOCK de fetch (vecteur 1024 fixe) :
 * chunks et requête reçoivent le MÊME vecteur → cosinus 1 → match sémantique garanti,
 * sans clé Mistral réelle. Done : page appliquée → chunks+embeddings → search la remonte
 * en sémantique (matchedBy inclut "semantic").
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     deno test --allow-env --allow-net --config supabase/functions/deno.json \
 *       supabase/functions/mcp/v3_indexing.test.ts
 */
import postgres from "postgres";

const DB = Deno.env.get("DATABASE_URL");
const DIM = 1024;
const V = Array.from({ length: DIM }, (_, i) => Math.sin(i * 0.5) + 1.1); // vecteur fixe non nul
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(`assertion failed: ${m}`); }
function assertEquals(a: unknown, b: unknown, m: string) { if (a !== b) throw new Error(`assertion failed: ${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test({
  name: "MCP v3 — indexation chunk+embed dans apply → search sémantique",
  ignore: !DB,
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  Deno.env.set("MEMENTO_MISTRAL_API_KEY", "test-key"); // active embed.v3 (fetch mocké)
  const origFetch = globalThis.fetch;
  // Mock : renvoie V pour chaque texte d'entrée (embeddings Mistral 1024).
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const n = Array.isArray(body.input) ? body.input.length : 1;
    return Promise.resolve(new Response(JSON.stringify({ data: Array.from({ length: n }, () => ({ embedding: V })) }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  }) as typeof fetch;

  const { v3ProposeChanges, v3Apply, v3Search } = await import("./v3.ts");
  const sql = postgres(DB!, { prepare: false });
  const tag = `idx-${crypto.randomUUID().slice(0, 8)}`;
  const sub = `${tag}-user`;
  try {
    const [org] = await sql`insert into mem_orgs (slug, name) values (${tag}, ${tag}) returning id`;
    const [base] = await sql`insert into mem_bases (org_id, name) values (${org.id}, ${tag}) returning id`;
    await sql`insert into mem_memberships (org_id, user_id, role) values (${org.id}, ${sub}, 'member')`;

    const prop = await v3ProposeChanges(sub, {
      title: "Indexation",
      base: base.id as string,
      clientKey: "ck-idx",
      changes: [{ op: "create_page", payload: { parentId: null, title: "Recherche sémantique", description: "doctrine", body: "on a retenu pgvector et mistral pour la recherche sémantique des pages" } }],
    });
    const ap = await v3Apply(sub, { ingestionId: prop.ingestionId });
    assertEquals(ap.status, "APPLIED", "apply → APPLIED");
    const pageId = (await sql`select id from mem_pages where base_id=${base.id}`)[0].id as string;

    // Indexation = async best-effort (fire-and-forget hors EdgeRuntime) → on poll.
    let chunks: { has_emb: boolean }[] = [];
    for (let i = 0; i < 80; i++) {
      chunks = await sql`select (embedding is not null) as has_emb from mem_page_chunks where page_id=${pageId}` as { has_emb: boolean }[];
      if (chunks.length && chunks.every((c) => c.has_emb)) break;
      await sleep(50);
    }
    assert(chunks.length > 0, "chunks créés par l'indexation");
    assert(chunks.every((c) => c.has_emb), "tous les chunks ont un embedding");

    // search sémantique : la requête est embeddée avec le MÊME mock → cosinus 1.
    const hits = await v3Search(sub, { q: "pgvector mistral", scope: "savoir", limit: 10 });
    const hit = hits.find((h) => h.pageId === pageId);
    assert(hit, "page retrouvée");
    assert(hit!.matchedBy.includes("semantic"), "match SÉMANTIQUE (indexation effective)");
  } finally {
    await sql`delete from mem_bases where name=${tag}`;
    await sql`delete from mem_orgs where slug=${tag}`;
    await sql.end();
    globalThis.fetch = origFetch;
    Deno.env.delete("MEMENTO_MISTRAL_API_KEY");
  }
});
