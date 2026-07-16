/**
 * V3 — embedding via **mistral-embed** (1024, hébergé, FR, souverain). Décision hub (#60) :
 * on quitte OpenAI text-embedding-3-small (= `semantic.ts`, v2 LIVE — NE PAS toucher).
 *
 * Best-effort : renvoie `null` si la clé est absente / l'API échoue / la dimension ≠ 1024
 * (pas de fallback caché — le backfill rattrape, le kNN ignore les NULL). La dim est FIGÉE
 * en `halfvec(1024)` par le schéma v3 (#53) → toute sortie d'une autre dim est rejetée.
 *
 * Clé : `MEMENTO_MISTRAL_API_KEY` (coffre → env). Lue À L'APPEL, pas au chargement →
 * le module s'importe sans clé et le test tourne sans réseau (mock de fetch).
 */
export const EMBEDDING_MODEL = "mistral-embed";
export const EMBEDDING_DIM = 1024; // figé dans halfvec(1024), schéma v3 (#53)
const MISTRAL_URL = "https://api.mistral.ai/v1/embeddings";
const MAX_CHARS = 8000; // garde-fou d'entrée (mirroir de la v2) — les chunks sont déjà bornés

/** Littéral `[a,b,…]` pour un cast `::halfvec`. */
export const toVec = (e: number[]): string => `[${e.join(",")}]`;

/**
 * Vectorise `texts` (1 vecteur/texte, ordre préservé). `null` = indisponible (best-effort).
 * Signature = l'interface `EmbedTexts` consommée par la recherche v3 (search.v3.ts).
 */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  const key = Deno.env.get("MEMENTO_MISTRAL_API_KEY");
  if (!key || !texts.length) return null;
  try {
    const res = await fetch(MISTRAL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts.map((t) => t.slice(0, MAX_CHARS)) }),
    });
    if (!res.ok) {
      console.error(`mistral-embed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const vecs: number[][] = (data?.data ?? []).map((d: { embedding: number[] }) => d.embedding);
    if (vecs.length !== texts.length) {
      console.error(`mistral-embed: ${vecs.length} vecteurs pour ${texts.length} textes`);
      return null;
    }
    // Garde-fou de dim : toute sortie ≠ 1024 → null (le schéma fige halfvec(1024)).
    if (vecs.some((v) => v?.length !== EMBEDDING_DIM)) {
      console.error(`mistral-embed: dim inattendue (reçu ${vecs[0]?.length}, attendu ${EMBEDDING_DIM})`);
      return null;
    }
    return vecs;
  } catch (e) {
    console.error("mistral-embed injoignable:", (e as Error).message);
    return null; // best-effort : le backfill rattrape
  }
}
