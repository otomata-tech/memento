/**
 * Résolution d'entités côté serveur (ADR 0002, issue #54) — l'« escalier ».
 *
 * Deux familles d'entités convergent ici :
 *  - NER (personne·entreprise·outil) : extraites par le micro-service GLiNER
 *    (`extractEntities`), async APRÈS l'apply (la page est écrite d'abord).
 *  - logique (decision…) : posée par l'agent via `assert_entity` (op `propose_changes`).
 * Les deux passent par le MÊME escalier (`resolveMention`).
 *
 * Invariant : 0 inférence LLM serveur en LECTURE. L'escalier est déterministe
 * (normalise → exact-match → trigram+Jaro-Winkler ∪ kNN → seuils → revue/stub).
 * L'adjudicateur LLM est un point d'extension OPTIONNEL, au WRITE seulement, sur
 * le seul résidu (après exact-match) — désactivé par défaut.
 *
 * Source unique de la normalisation = la fn SQL `normalise_name` (migration v3).
 * On ne la ré-implémente JAMAIS en TS (le store l'appelle).
 *
 * Périmètre du fichier : la résolution + le client NER. Il ne décide pas du
 * networking (URL/bearer via env) ni du déclenchement (l'apply l'appelle, non bloquant).
 */
import { sql } from "drizzle-orm";
// `import type` : erasé au runtime (pas de chargement de pg-core), mais on dérive
// le type depuis le schéma figé plutôt que de dupliquer l'union (derive don't duplicate).
import type { entityType } from "../../../server/src/schema.v3.ts";

export type EntityType = (typeof entityType.enumValues)[number]; // personne|entreprise|outil|decision
/** Sous-ensemble que le service NER sait extraire (les 3 types verrouillés, ADR 0002 §3). */
export type NerEntityType = "personne" | "entreprise" | "outil";

// ── Client NER ────────────────────────────────────────────────────────────────
// Contrat du micro-service (ner/README.md) :
//   POST /extract {text, threshold?} -> {entities:[{text,type,score,start,end}]}
//   bearer partagé `Authorization: Bearer $NER_API_KEY`.

export interface NerEntity {
  text: string;
  type: NerEntityType;
  score: number;
  start: number;
  end: number;
}

export interface ExtractOptions {
  threshold?: number;
  signal?: AbortSignal;
}

function nerEndpoint(path: string): string {
  const base = Deno.env.get("NER_URL");
  if (!base) throw new Error("NER_URL is missing");
  return `${base.replace(/\/+$/, "")}${path}`;
}

function nerHeaders(): Record<string, string> {
  const key = Deno.env.get("NER_API_KEY");
  return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

/** Extrait les entités NER d'un texte. Appelée en async hors chemin chaud (l'apply écrit la page d'abord). */
export async function extractEntities(text: string, opts: ExtractOptions = {}): Promise<NerEntity[]> {
  const res = await fetch(nerEndpoint("/extract"), {
    method: "POST",
    headers: nerHeaders(),
    body: JSON.stringify({ text, ...(opts.threshold != null ? { threshold: opts.threshold } : {}) }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`NER /extract ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return (data?.entities ?? []) as NerEntity[];
}

/** Variante batch (≤64 textes) — utile pour découper une page longue. */
export async function extractEntitiesBatch(texts: string[], opts: ExtractOptions = {}): Promise<NerEntity[][]> {
  if (!texts.length) return [];
  const res = await fetch(nerEndpoint("/extract_batch"), {
    method: "POST",
    headers: nerHeaders(),
    body: JSON.stringify({ texts, ...(opts.threshold != null ? { threshold: opts.threshold } : {}) }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`NER /extract_batch ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return (data?.results ?? []) as NerEntity[][];
}

// ── Jaro-Winkler (rescore des candidats trigram) ──────────────────────────────
// Implémenté côté serveur car `pg_similarity` est ABSENT de Supabase Cloud (ADR 0002 §4).
// Pur, déterministe, unit-testable.

/** Similarité Jaro ∈ [0,1]. */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array<boolean>(a.length).fill(false);
  const bMatch = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const m = matches;
  return (m / a.length + m / b.length + (m - t / 2) / m) / 3;
}

/** Jaro-Winkler : Jaro + bonus de préfixe commun (≤4 chars, facteur 0.1). */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const j = jaro(a, b);
  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  return j + prefix * prefixScale * (1 - j);
}

// ── Configuration (seuils) — env-overridable, à arbitrer avec Alexis ──────────
export interface ResolveConfig {
  /** Pré-filtre trigram (recall des candidats côté DB). */
  trigramThreshold: number;
  /** ≥ ce score (JW ou cosinus) → auto-lié à un candidat existant. */
  autolinkThreshold: number;
  /** dans [reviewThreshold, autolinkThreshold[ → stub + suggestion de fusion (revue). */
  reviewThreshold: number;
  /** is_stub=false dès ce nombre de mentions. */
  promoteMinMentions: number;
  /** Top-N candidats. */
  candidateLimit: number;
}

function envNum(name: string, dflt: number): number {
  const v = Deno.env.get(name);
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}

export function defaultConfig(): ResolveConfig {
  return {
    // 0.3 = défaut pg_trgm (tranché : l'issue suggérait 0.7, trop agressif — l'espace
    // casse les trigrammes de « Lumera Pay »/« Lumerapay » ; JW + bandes tranchent ensuite).
    trigramThreshold: envNum("MEMENTO_ENTITY_TRIGRAM_THRESHOLD", 0.3),
    // conservateur : « 0 faux-merge auto » (Done). Le quasi-doublon doit tomber EN REVUE.
    autolinkThreshold: envNum("MEMENTO_ENTITY_AUTOLINK_THRESHOLD", 0.95),
    reviewThreshold: envNum("MEMENTO_ENTITY_REVIEW_THRESHOLD", 0.8),
    promoteMinMentions: envNum("MEMENTO_ENTITY_PROMOTE_MIN_MENTIONS", 2),
    candidateLimit: envNum("MEMENTO_ENTITY_CANDIDATE_LIMIT", 20),
  };
}

// ── Port (store) : tout l'accès DB de l'escalier passe par cette interface ─────
// → adaptateur Postgres en prod (createPgStore), fake en mémoire dans les tests.

// `type` (pas `interface`) : requis pour satisfaire la contrainte
// `db.execute<T extends Record<string, unknown>>` de drizzle.
export type EntityRow = {
  id: string;
  canonicalLabel: string;
  normalisedLabel: string;
  isStub: boolean;
};

export type Candidate = EntityRow & {
  /** cosinus kNN sur name_embedding, si disponible. */
  cosine?: number | null;
};

export interface CreateStubArgs {
  orgId: string;
  type: EntityType;
  canonicalLabel: string;
  normalisedLabel: string;
  attributes?: Record<string, unknown> | null;
  embedding?: number[] | null;
}

export interface MentionArgs {
  pageId: string;
  entityId: string;
  span?: string | null;
  confidence?: number | null;
}

export interface ReviewArgs {
  orgId: string;
  entityKeep: string;
  entityDrop: string;
  score: number;
  method: string;
  actor?: string;
}

export interface EntityStore {
  /** Source unique de la normalisation = fn SQL `normalise_name`. */
  normalise(label: string): Promise<string>;
  findExact(orgId: string, type: EntityType, normalisedLabel: string): Promise<EntityRow | null>;
  candidates(args: {
    orgId: string;
    type: EntityType;
    normalisedLabel: string;
    embedding?: number[] | null;
    trigramThreshold: number;
    limit: number;
  }): Promise<Candidate[]>;
  createStub(args: CreateStubArgs): Promise<EntityRow>;
  addMention(args: MentionArgs): Promise<void>;
  /** is_stub=false dès `minMentions` mentions. */
  promoteIfEnough(entityId: string, minMentions: number): Promise<void>;
  createReview(args: ReviewArgs): Promise<void>;
}

/** Adjudicateur LLM — point d'extension OPTIONNEL, au write, sur le résidu. Défaut : aucun. */
export interface Adjudicator {
  adjudicate(input: {
    mention: ResolveInput;
    normalisedLabel: string;
    candidates: Candidate[];
  }): Promise<
    | { link: string } // lier à cette entité existante
    | { review: string } // suggérer une fusion (keep = cet id) + stub
    | null // pas d'avis → on retombe sur le déterministe
  >;
}

export interface ResolveDeps {
  store: EntityStore;
  config?: Partial<ResolveConfig>;
  adjudicator?: Adjudicator;
  /** Calcule l'embedding du label (best-effort). Absent → pas de kNN, name_embedding NULL (backfill). */
  embed?: (text: string) => Promise<number[] | null>;
}

// ── L'escalier ────────────────────────────────────────────────────────────────

export interface ResolveInput {
  orgId: string;
  pageId: string;
  type: EntityType;
  label: string;
  span?: string | null;
  confidence?: number | null;
  /** famille « événement » (decision) : status / occurred_at / supersedes → entity.attributes. */
  attributes?: Record<string, unknown> | null;
  actor?: string; // par défaut "ner"
}

export type ResolveOutcome =
  | { action: "exact"; entityId: string; isNew: boolean }
  | { action: "auto_link"; entityId: string; score: number; method: string }
  | { action: "stub_review"; entityId: string; keepId: string; score: number; method: string }
  | { action: "stub"; entityId: string };

function scoreCandidate(normalised: string, c: Candidate): { score: number; method: string } {
  const jw = jaroWinkler(normalised, c.normalisedLabel);
  const cos = c.cosine ?? -1;
  return cos > jw ? { score: cos, method: "knn" } : { score: jw, method: "jaro_winkler" };
}

/**
 * Résout UNE mention (NER-extraite ou agent-posée) contre la table d'entités de l'org.
 * Async après l'apply. Crée/lie l'entité + la mention, alimente la file de revue.
 */
export async function resolveMention(deps: ResolveDeps, m: ResolveInput): Promise<ResolveOutcome> {
  const cfg = { ...defaultConfig(), ...deps.config };
  const { store } = deps;
  const actor = m.actor ?? "ner";
  const normalised = await store.normalise(m.label);

  // 1. Exact-match (déterministe, silencieux, 0 LLM).
  const existing = await store.findExact(m.orgId, m.type, normalised);
  if (existing) {
    await store.addMention({ pageId: m.pageId, entityId: existing.id, span: m.span, confidence: m.confidence });
    await store.promoteIfEnough(existing.id, cfg.promoteMinMentions);
    return { action: "exact", entityId: existing.id, isNew: false };
  }

  // 2. Candidats : trigram (rescore JW) ∪ kNN. On garde le meilleur.
  const embedding = deps.embed ? await deps.embed(m.label).catch(() => null) : null;
  const cands = await store.candidates({
    orgId: m.orgId,
    type: m.type,
    normalisedLabel: normalised,
    embedding,
    trigramThreshold: cfg.trigramThreshold,
    limit: cfg.candidateLimit,
  });
  let best: { cand: Candidate; score: number; method: string } | null = null;
  for (const c of cands) {
    const { score, method } = scoreCandidate(normalised, c);
    if (!best || score > best.score) best = { cand: c, score, method };
  }

  // 2bis. Adjudicateur (optionnel) : seulement sur le résidu (pas d'exact, pas d'auto-link sûr).
  if (deps.adjudicator && (!best || best.score < cfg.autolinkThreshold)) {
    const verdict = await deps.adjudicator
      .adjudicate({ mention: m, normalisedLabel: normalised, candidates: cands })
      .catch(() => null);
    if (verdict && "link" in verdict) {
      await store.addMention({ pageId: m.pageId, entityId: verdict.link, span: m.span, confidence: m.confidence });
      await store.promoteIfEnough(verdict.link, cfg.promoteMinMentions);
      return { action: "auto_link", entityId: verdict.link, score: 1, method: "adjudicator" };
    }
    if (verdict && "review" in verdict) {
      const stub = await store.createStub({
        orgId: m.orgId, type: m.type, canonicalLabel: m.label, normalisedLabel: normalised,
        attributes: m.attributes, embedding,
      });
      await store.addMention({ pageId: m.pageId, entityId: stub.id, span: m.span, confidence: m.confidence });
      await store.promoteIfEnough(stub.id, cfg.promoteMinMentions);
      await store.createReview({ orgId: m.orgId, entityKeep: verdict.review, entityDrop: stub.id, score: 1, method: "adjudicator", actor });
      return { action: "stub_review", entityId: stub.id, keepId: verdict.review, score: 1, method: "adjudicator" };
    }
  }

  // 3a. Score ≥ seuil haut → auto-lié au candidat existant.
  if (best && best.score >= cfg.autolinkThreshold) {
    await store.addMention({ pageId: m.pageId, entityId: best.cand.id, span: m.span, confidence: m.confidence });
    await store.promoteIfEnough(best.cand.id, cfg.promoteMinMentions);
    return { action: "auto_link", entityId: best.cand.id, score: best.score, method: best.method };
  }

  // 3b/4. Pas d'auto-link → on crée un stub (anti-course via ON CONFLICT), + mention.
  const stub = await store.createStub({
    orgId: m.orgId, type: m.type, canonicalLabel: m.label, normalisedLabel: normalised,
    attributes: m.attributes, embedding,
  });
  await store.addMention({ pageId: m.pageId, entityId: stub.id, span: m.span, confidence: m.confidence });
  await store.promoteIfEnough(stub.id, cfg.promoteMinMentions);

  // 3c. Plausible mais incertain → suggestion de fusion (NON bloquant).
  if (best && best.score >= cfg.reviewThreshold) {
    await store.createReview({ orgId: m.orgId, entityKeep: best.cand.id, entityDrop: stub.id, score: best.score, method: best.method, actor });
    return { action: "stub_review", entityId: stub.id, keepId: best.cand.id, score: best.score, method: best.method };
  }
  return { action: "stub", entityId: stub.id };
}

// ── Orchestrateur page : extrait (NER) puis résout chaque mention ─────────────
// Appelé en async APRÈS l'apply (non bloquant). Best-effort : ne jamais faire échouer
// l'apply à cause du NER ou de la résolution → wrapper try/catch côté apply.

export async function resolvePageEntities(
  deps: ResolveDeps & { ner?: (text: string) => Promise<NerEntity[]> },
  args: { orgId: string; pageId: string; text: string },
): Promise<ResolveOutcome[]> {
  const extract = deps.ner ?? ((t: string) => extractEntities(t));
  const ents = await extract(args.text);
  const out: ResolveOutcome[] = [];
  for (const e of ents) {
    out.push(
      await resolveMention(deps, {
        orgId: args.orgId,
        pageId: args.pageId,
        type: e.type,
        label: e.text,
        span: e.text,
        confidence: e.score,
        actor: "ner",
      }),
    );
  }
  return out;
}

// ── Adaptateur Postgres (prod) ────────────────────────────────────────────────
// Raw SQL : ON CONFLICT (exact-match anti-course), pg_trgm, kNN halfvec.

const toVec = (e: number[]) => `[${e.join(",")}]`;

// db chargé paresseusement : importer ce module (résolution + client NER) ne doit
// PAS exiger DATABASE_URL — seul l'adaptateur Postgres en a besoin, au 1er appel.
let _db: typeof import("./db.ts").db | null = null;
async function getDb() {
  if (!_db) _db = (await import("./db.ts")).db;
  return _db;
}

export function createPgStore(): EntityStore {
  return {
    async normalise(label) {
      const rows = await (await getDb()).execute<{ n: string }>(sql`select normalise_name(${label}) as n`);
      return rows[0]?.n ?? "";
    },

    async findExact(orgId, type, normalisedLabel) {
      const rows = await (await getDb()).execute<EntityRow>(sql`
        select id, canonical_label as "canonicalLabel", normalised_label as "normalisedLabel", is_stub as "isStub"
        from mem_entities
        where org_id = ${orgId} and type = ${type}::mem_entity_type and normalised_label = ${normalisedLabel}
        limit 1`);
      return rows[0] ?? null;
    },

    async candidates({ orgId, type, normalisedLabel, embedding, trigramThreshold, limit }) {
      // Arm trigram : pré-filtre recall (le rescore JW final se fait côté TS).
      const trgm = await (await getDb()).execute<Candidate>(sql`
        select id, canonical_label as "canonicalLabel", normalised_label as "normalisedLabel",
               is_stub as "isStub", null::double precision as cosine
        from mem_entities
        where org_id = ${orgId} and type = ${type}::mem_entity_type
          and normalised_label <> ${normalisedLabel}
          and similarity(normalised_label, ${normalisedLabel}) > ${trigramThreshold}
        order by similarity(normalised_label, ${normalisedLabel}) desc
        limit ${limit}`);

      // Arm kNN : seulement si on a un embedding pour le label entrant.
      let knn: Candidate[] = [];
      if (embedding?.length) {
        const lit = toVec(embedding);
        knn = await (await getDb()).execute<Candidate>(sql`
          select id, canonical_label as "canonicalLabel", normalised_label as "normalisedLabel",
                 is_stub as "isStub", 1 - (name_embedding <=> ${lit}::halfvec) as cosine
          from mem_entities
          where org_id = ${orgId} and type = ${type}::mem_entity_type
            and normalised_label <> ${normalisedLabel}
            and name_embedding is not null
          order by name_embedding <=> ${lit}::halfvec
          limit ${limit}`);
      }

      // Union dédupliquée par id (garde le cosinus s'il existe).
      const byId = new Map<string, Candidate>();
      for (const c of [...trgm, ...knn]) {
        const prev = byId.get(c.id);
        if (!prev) byId.set(c.id, c);
        else if (c.cosine != null) prev.cosine = c.cosine;
      }
      return [...byId.values()];
    },

    async createStub({ orgId, type, canonicalLabel, normalisedLabel, attributes, embedding }) {
      const attrs = attributes != null ? JSON.stringify(attributes) : null;
      const emb = embedding?.length ? toVec(embedding) : null;
      const rows = await (await getDb()).execute<EntityRow>(sql`
        insert into mem_entities (org_id, type, canonical_label, normalised_label, is_stub, attributes, name_embedding)
        values (${orgId}, ${type}::mem_entity_type, ${canonicalLabel}, ${normalisedLabel}, true,
                ${attrs}::jsonb, ${emb}::halfvec)
        on conflict (org_id, type, normalised_label)
          do update set canonical_label = mem_entities.canonical_label
        returning id, canonical_label as "canonicalLabel", normalised_label as "normalisedLabel", is_stub as "isStub"`);
      return rows[0];
    },

    async addMention({ pageId, entityId, span, confidence }) {
      await (await getDb()).execute(sql`
        insert into mem_mentions (page_id, entity_id, span, confidence)
        values (${pageId}, ${entityId}, ${span ?? null}, ${confidence ?? null})
        on conflict (page_id, entity_id) do nothing`);
    },

    async promoteIfEnough(entityId, minMentions) {
      await (await getDb()).execute(sql`
        update mem_entities set is_stub = false
        where id = ${entityId} and is_stub = true
          and (select count(*) from mem_mentions where entity_id = ${entityId}) >= ${minMentions}`);
    },

    async createReview({ orgId, entityKeep, entityDrop, score, method, actor }) {
      // Idempotent : pas de doublon de suggestion pending pour la même paire.
      await (await getDb()).execute(sql`
        insert into mem_entity_reviews (org_id, entity_keep, entity_drop, score, method, created_by)
        select ${orgId}, ${entityKeep}, ${entityDrop}, ${score}, ${method}, ${actor ?? null}
        where not exists (
          select 1 from mem_entity_reviews
          where org_id = ${orgId} and entity_keep = ${entityKeep} and entity_drop = ${entityDrop} and status = 'pending')`);
    },
  };
}

/** Dépendances de prod (store Postgres, escalier déterministe, pas d'adjudicateur). */
export function defaultDeps(): ResolveDeps {
  return { store: createPgStore() };
}
