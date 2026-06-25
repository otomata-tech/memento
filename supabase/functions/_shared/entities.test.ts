/**
 * Tests de la résolution d'entités (issue #54) — SANS base de données.
 *
 * L'escalier est testé contre un store EN MÉMOIRE (port `EntityStore`) → fixtures FR,
 * déterministe, hermétique. Le client NER est testé contre un mock de `fetch`.
 *
 *   deno test --allow-env supabase/functions/_shared/entities.test.ts
 *
 * NB : le store en mémoire fournit une normalisation de TEST (lowercase + accents +
 * espaces) — la prod utilise la fn SQL `normalise_name` (source unique). Le test
 * vérifie l'ESCALIER (banding exact/auto/review/stub + promotion), pas la normalisation.
 */
import {
  Candidate,
  EntityRow,
  EntityStore,
  extractEntities,
  jaroWinkler,
  resolveMention,
  resolvePageEntities,
  type EntityType,
  type NerEntity,
} from "./entities.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`assertion failed: ${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// ── Store en mémoire ──────────────────────────────────────────────────────────
interface MemEntity extends EntityRow { orgId: string; type: EntityType; }
interface MemMention { pageId: string; entityId: string; }
interface MemReview { orgId: string; entityKeep: string; entityDrop: string; score: number; method: string; }

function testNormalise(label: string): string {
  return label
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

class MemStore implements EntityStore {
  entities: MemEntity[] = [];
  mentions: MemMention[] = [];
  reviews: MemReview[] = [];
  private seq = 0;

  seed(orgId: string, type: EntityType, label: string, isStub = false): MemEntity {
    const e: MemEntity = {
      id: `seed-${++this.seq}`, orgId, type,
      canonicalLabel: label, normalisedLabel: testNormalise(label), isStub,
    };
    this.entities.push(e);
    return e;
  }

  normalise(label: string) { return Promise.resolve(testNormalise(label)); }

  findExact(orgId: string, type: EntityType, normalisedLabel: string) {
    return Promise.resolve(
      this.entities.find((e) => e.orgId === orgId && e.type === type && e.normalisedLabel === normalisedLabel) ?? null,
    );
  }

  candidates(args: { orgId: string; type: EntityType; normalisedLabel: string }): Promise<Candidate[]> {
    // petit set de test → on renvoie tout le même type (le rescore JW + seuils tranchent).
    return Promise.resolve(
      this.entities
        .filter((e) => e.orgId === args.orgId && e.type === args.type && e.normalisedLabel !== args.normalisedLabel)
        .map((e) => ({ ...e, cosine: null })),
    );
  }

  createStub(args: { orgId: string; type: EntityType; canonicalLabel: string; normalisedLabel: string }): Promise<EntityRow> {
    const found = this.entities.find(
      (e) => e.orgId === args.orgId && e.type === args.type && e.normalisedLabel === args.normalisedLabel,
    );
    if (found) return Promise.resolve(found);
    const e: MemEntity = { id: `stub-${++this.seq}`, orgId: args.orgId, type: args.type, canonicalLabel: args.canonicalLabel, normalisedLabel: args.normalisedLabel, isStub: true };
    this.entities.push(e);
    return Promise.resolve(e);
  }

  addMention(args: { pageId: string; entityId: string }) {
    if (!this.mentions.some((m) => m.pageId === args.pageId && m.entityId === args.entityId)) {
      this.mentions.push({ pageId: args.pageId, entityId: args.entityId });
    }
    return Promise.resolve();
  }

  promoteIfEnough(entityId: string, minMentions: number) {
    const e = this.entities.find((x) => x.id === entityId);
    if (e && e.isStub && this.mentions.filter((m) => m.entityId === entityId).length >= minMentions) e.isStub = false;
    return Promise.resolve();
  }

  createReview(args: { orgId: string; entityKeep: string; entityDrop: string; score: number; method: string }) {
    if (!this.reviews.some((r) => r.entityKeep === args.entityKeep && r.entityDrop === args.entityDrop)) {
      this.reviews.push({ orgId: args.orgId, entityKeep: args.entityKeep, entityDrop: args.entityDrop, score: args.score, method: args.method });
    }
    return Promise.resolve();
  }
}

const ORG = "org-1";
// On teste les SEUILS LIVRÉS (defaultConfig : autolink 0.95 / review 0.80 / promote 2).
const DEPS = (store: MemStore) => ({ store });

Deno.test("escalier — exact-match auto (insensible à la casse via normalise)", async () => {
  const store = new MemStore();
  const mm = store.seed(ORG, "entreprise", "Lumera");
  const out = await resolveMention(DEPS(store), {
    orgId: ORG, pageId: "p1", type: "entreprise", label: "LUMERA",
  });
  assertEquals(out.action, "exact", "exact-match");
  assert(out.action === "exact" && out.entityId === mm.id && !out.isNew, "lié à l'entité existante, pas de création");
  assertEquals(store.entities.length, 1, "aucune entité créée");
  assertEquals(store.reviews.length, 0, "aucune revue");
});

Deno.test("escalier — quasi-doublon → stub + entity_review (0 faux-merge auto)", async () => {
  const store = new MemStore();
  const mm = store.seed(ORG, "entreprise", "Lumera");
  // « Lumera SAS » vs « Lumera » : JW ≈ 0.95 → bande revue (< autolink 0.95, ≥ review 0.80).
  const out = await resolveMention(DEPS(store), {
    orgId: ORG, pageId: "p1", type: "entreprise", label: "Lumera SAS",
  });
  assertEquals(out.action, "stub_review", "quasi-doublon → revue");
  assert(out.action === "stub_review" && out.keepId === mm.id, "suggestion garde l'entité canonique");
  assertEquals(store.entities.length, 2, "un stub créé (PAS de merge auto)");
  assertEquals(store.reviews.length, 1, "une suggestion de fusion");
  const stub = store.entities.find((e) => e.id !== mm.id)!;
  assert(stub.isStub, "le nouveau est un stub");
});

Deno.test("escalier — nouveau (aucun candidat) → stub, sans revue", async () => {
  const store = new MemStore();
  store.seed(ORG, "entreprise", "Lumera");
  const out = await resolveMention(DEPS(store), {
    orgId: ORG, pageId: "p1", type: "outil", label: "Pennylane",
  });
  assertEquals(out.action, "stub", "nouveau → stub");
  assertEquals(store.reviews.length, 0, "pas de revue pour un nouveau franc");
  const stub = store.entities.find((e) => e.type === "outil")!;
  assert(stub && stub.isStub, "stub créé");
});

Deno.test("escalier — promotion is_stub=false dès 2 mentions (sur 2 pages)", async () => {
  const store = new MemStore();
  const deps = DEPS(store);
  const o1 = await resolveMention(deps, { orgId: ORG, pageId: "p1", type: "outil", label: "Pennylane" });
  assert(o1.action === "stub", "1re mention → stub");
  const stub = store.entities.find((e) => e.type === "outil")!;
  assert(stub.isStub, "encore stub après 1 mention");
  const o2 = await resolveMention(deps, { orgId: ORG, pageId: "p2", type: "outil", label: "Pennylane" });
  assertEquals(o2.action, "exact", "2e mention → exact-match sur le stub");
  assert(!stub.isStub, "promu (is_stub=false) à la 2e mention");
});

Deno.test("escalier — entités distinctes ne fusionnent jamais (Slack vs Notion)", async () => {
  const store = new MemStore();
  store.seed(ORG, "outil", "Notion");
  const out = await resolveMention(DEPS(store), {
    orgId: ORG, pageId: "p1", type: "outil", label: "Slack",
  });
  assertEquals(out.action, "stub", "Slack ≠ Notion → stub, pas de merge ni revue");
  assertEquals(store.reviews.length, 0, "aucune revue");
});

Deno.test("orchestrateur — extrait (NER mock) puis résout chaque mention", async () => {
  const store = new MemStore();
  store.seed(ORG, "personne", "Jean Dupont");
  const ner = (_text: string): Promise<NerEntity[]> =>
    Promise.resolve([
      { text: "Jean Dupont", type: "personne", score: 0.97, start: 0, end: 15 },
      { text: "Pennylane", type: "outil", score: 0.88, start: 20, end: 29 },
    ]);
  const outs = await resolvePageEntities({ store, ner }, {
    orgId: ORG, pageId: "p1", text: "Jean Dupont a adopté Pennylane.",
  });
  assertEquals(outs.length, 2, "2 mentions résolues");
  assertEquals(outs[0].action, "exact", "personne existante → exact");
  assertEquals(outs[1].action, "stub", "outil nouveau → stub");
});

Deno.test("client NER — extractEntities contre un mock de fetch", async () => {
  Deno.env.set("NER_URL", "http://ner.local");
  Deno.env.set("NER_API_KEY", "secret-test");
  const orig = globalThis.fetch;
  let seenUrl = "";
  let seenAuth: string | null = null;
  let seenBody: unknown = null;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input);
    seenAuth = new Headers(init?.headers).get("authorization");
    seenBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(JSON.stringify({ entities: [{ text: "Otomata", type: "entreprise", score: 0.91, start: 0, end: 7 }] }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    const ents = await extractEntities("Otomata SASU.", { threshold: 0.6 });
    assertEquals(seenUrl, "http://ner.local/extract", "endpoint /extract (slash normalisé)");
    assertEquals(seenAuth, "Bearer secret-test", "bearer NER_API_KEY");
    assertEquals((seenBody as { threshold: number }).threshold, 0.6, "threshold transmis");
    assertEquals(ents.length, 1, "1 entité");
    assertEquals(ents[0].text, "Otomata", "parse OK");
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("NER_URL");
    Deno.env.delete("NER_API_KEY");
  }
});

Deno.test("client NER — erreur HTTP → throw (pas de fallback silencieux)", async () => {
  Deno.env.set("NER_URL", "http://ner.local");
  const orig = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response("boom", { status: 503 }))) as typeof fetch;
  try {
    let threw = false;
    try { await extractEntities("x"); } catch { threw = true; }
    assert(threw, "503 → exception");
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("NER_URL");
  }
});

Deno.test("extractEntities — NER_URL manquante → erreur claire", async () => {
  Deno.env.delete("NER_URL");
  let msg = "";
  try { await extractEntities("x"); } catch (e) { msg = (e as Error).message; }
  assert(msg.includes("NER_URL"), "message mentionne NER_URL");
});

Deno.test("jaroWinkler — sanity (bonus de préfixe, bornes)", () => {
  assertEquals(jaroWinkler("abc", "abc"), 1, "identiques = 1");
  assertEquals(jaroWinkler("", "abc"), 0, "vide = 0");
  assert(jaroWinkler("lumerapay", "lumera pay") > 0.85, "quasi-doublon proche élevé");
  assert(jaroWinkler("slack", "notion") < 0.6, "distincts faibles");
});
