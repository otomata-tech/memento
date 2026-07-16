/**
 * Test unitaire de `chunkText` (#62) — pur, hermétique (sans DB ni réseau).
 *   deno test --allow-env supabase/functions/_shared/indexing.v3.test.ts
 */
import { chunkText } from "./indexing.v3.ts";

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(`assertion failed: ${m}`); }
function assertEquals(a: unknown, b: unknown, m: string) { if (a !== b) throw new Error(`assertion failed: ${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }

Deno.test("chunkText — vide → []", () => {
  assertEquals(chunkText("").length, 0, "chaîne vide");
  assertEquals(chunkText("   \n  ").length, 0, "blancs seuls");
});

Deno.test("chunkText — un paragraphe → 1 chunk", () => {
  const c = chunkText("on a retenu pgvector et mistral");
  assertEquals(c.length, 1, "1 chunk");
  assertEquals(c[0], "on a retenu pgvector et mistral", "contenu intact");
});

Deno.test("chunkText — découpe par titres markdown", () => {
  const c = chunkText("# Intro\nblabla intro\n## Détail\nbla détail\n### Sous\nencore");
  assertEquals(c.length, 3, "3 sections (une par titre)");
  assert(c[0].startsWith("# Intro"), "section 1 = Intro");
  assert(c[1].startsWith("## Détail"), "section 2 = Détail");
  assert(c[2].startsWith("### Sous"), "section 3 = Sous");
});

Deno.test("chunkText — texte avant le 1er titre = sa propre section", () => {
  const c = chunkText("préambule sans titre\n# Titre\ncorps");
  assertEquals(c.length, 2, "préambule + section titrée");
  assertEquals(c[0], "préambule sans titre", "préambule isolé");
});

Deno.test("chunkText — fenêtre les sections trop longues", () => {
  const c = chunkText("x".repeat(3500), 1500);
  assertEquals(c.length, 3, "3 fenêtres (1500+1500+500)");
  assertEquals(c[0].length, 1500, "fenêtre pleine");
  assertEquals(c[2].length, 500, "dernière fenêtre");
});
