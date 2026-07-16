/**
 * Test du module embedding v3 (#60) — contre un MOCK de fetch, AUCUN appel réel.
 * Vert sans DATABASE_URL ni MEMENTO_MISTRAL_API_KEY.
 *
 *   deno test --allow-env supabase/functions/_shared/embed.v3.test.ts
 */
import { EMBEDDING_DIM, EMBEDDING_MODEL, embedTexts, toVec } from "./embed.v3.ts";

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(`assertion failed: ${m}`); }
function assertEquals(a: unknown, b: unknown, m: string) {
  if (a !== b) throw new Error(`assertion failed: ${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

const KEY = "MEMENTO_MISTRAL_API_KEY";
const dimVec = (fill = 0.1) => new Array(EMBEDDING_DIM).fill(fill);

function mockFetch(handler: (url: string, init?: RequestInit) => Response): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

Deno.test("embedTexts — clé absente → null sans appel réseau", async () => {
  Deno.env.delete(KEY);
  let called = false;
  const restore = mockFetch(() => { called = true; return new Response("{}"); });
  try {
    assertEquals(await embedTexts(["x"]), null, "null sans clé");
    assert(!called, "fetch jamais appelé");
  } finally { restore(); }
});

Deno.test("embedTexts — texts vide → null", async () => {
  Deno.env.set(KEY, "sk-test");
  try { assertEquals(await embedTexts([]), null, "null si aucun texte"); } finally { Deno.env.delete(KEY); }
});

Deno.test("embedTexts — succès : requête conforme + vecteurs parsés", async () => {
  Deno.env.set(KEY, "sk-test");
  let seenUrl = "", seenAuth: string | null = null;
  let seenBody: { model: string; input: string[] } | null = null;
  const restore = mockFetch((url, init) => {
    seenUrl = url;
    seenAuth = new Headers(init?.headers).get("authorization");
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: [{ embedding: dimVec(0.1) }, { embedding: dimVec(0.2) }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  try {
    const out = await embedTexts(["alpha", "beta"]);
    assert(out !== null, "non null");
    assertEquals(out!.length, 2, "2 vecteurs");
    assertEquals(out![0].length, EMBEDDING_DIM, "dim 1024");
    assertEquals(seenUrl, "https://api.mistral.ai/v1/embeddings", "endpoint Mistral");
    assertEquals(seenAuth, "Bearer sk-test", "bearer depuis l'env");
    assertEquals(seenBody!.model, EMBEDDING_MODEL, "model mistral-embed");
    assertEquals(seenBody!.input.length, 2, "input = 2 textes");
  } finally { restore(); Deno.env.delete(KEY); }
});

Deno.test("embedTexts — garde-fou de dim : ≠ 1024 → null", async () => {
  Deno.env.set(KEY, "sk-test");
  const restore = mockFetch(() =>
    new Response(JSON.stringify({ data: [{ embedding: new Array(512).fill(0.1) }] }), { status: 200 }));
  try { assertEquals(await embedTexts(["x"]), null, "dim 512 rejetée"); } finally { restore(); Deno.env.delete(KEY); }
});

Deno.test("embedTexts — count mismatch (moins de vecteurs que de textes) → null", async () => {
  Deno.env.set(KEY, "sk-test");
  const restore = mockFetch(() =>
    new Response(JSON.stringify({ data: [{ embedding: dimVec() }] }), { status: 200 }));
  try { assertEquals(await embedTexts(["a", "b"]), null, "1 vecteur pour 2 textes → null"); } finally { restore(); Deno.env.delete(KEY); }
});

Deno.test("embedTexts — erreur HTTP → null (best-effort, pas de throw)", async () => {
  Deno.env.set(KEY, "sk-test");
  const restore = mockFetch(() => new Response("rate limited", { status: 429 }));
  try { assertEquals(await embedTexts(["x"]), null, "429 → null"); } finally { restore(); Deno.env.delete(KEY); }
});

Deno.test("embedTexts — réseau injoignable → null", async () => {
  Deno.env.set(KEY, "sk-test");
  const orig = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
  try { assertEquals(await embedTexts(["x"]), null, "throw fetch → null"); } finally { globalThis.fetch = orig; Deno.env.delete(KEY); }
});

Deno.test("toVec — littéral halfvec", () => {
  assertEquals(toVec([1, 2, 3]), "[1,2,3]", "format [a,b,c]");
  assertEquals(toVec([]), "[]", "vecteur vide");
});
