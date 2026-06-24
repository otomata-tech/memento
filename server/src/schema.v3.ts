/**
 * Memento V3 — schéma page-centré (CONTRAT). ADR 0001 (page-centré), 0002 (entités
 * deux familles), 0003 (1 base/org + accès par page). Remplace `schema.ts` (v2
 * bloc-centré) au cutover ; gardé à part pour ne pas casser la v2 live pendant le build.
 *
 * Changements clés vs v2 :
 *  - PLUS de `block` ni de `link` typé. Une PAGE = prose pure (titre+description+corps), un ARBRE.
 *  - Fusion Dossier+Page → `page` (le seul nœud de structure ET de contenu).
 *  - `entity` = objet de 1er ordre NIVEAU ORG, table à part, 2 familles (NER + logique).
 *  - 1 base par org (`base.org_id UNIQUE`). Accès PAR PAGE (visibilité + grants user).
 *
 * Colonnes ajoutées HORS Drizzle par migration SQL (comme la v2 pour tsvector) :
 *  - `page.body_fts` tsvector + `source.fts` tsvector (FR) ;
 *  - `page_chunk.embedding` halfvec(<dim>) + index HNSW partiel (status='active') ;
 *  - `entity.name_embedding` halfvec(<dim>) ;
 *  - index GIN trigram sur `entity.normalised_label` ;
 *  - fn `normalise_name(text)` IMMUTABLE (= la clé de résolution, source unique).
 */
import {
  pgTable,
  pgEnum,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  uuid,
  primaryKey,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ── Enums ────────────────────────────────────────────────────────────────────
// Accès par page (ADR 0003). private = proprio + grants ; org = membres ; public = tous (lien seul).
export const pageVisibility = pgEnum("mem_page_visibility", ["private", "org", "public"]);
export const pageStatus = pgEnum("mem_page_status", ["active", "deprecated"]);
// Entités (ADR 0002). 3 types NER (extraites serveur) + decision (logique, posée par l'agent).
// Les types 2e niveau (reunion, contrat, projet, lieu, date…) sont DIFFÉRÉS — pas dans l'enum v1.
export const entityType = pgEnum("mem_entity_type", ["personne", "entreprise", "outil", "decision"]);
export const sourceKind = pgEnum("mem_source_kind", ["url", "file", "texte"]);
export const grantMode = pgEnum("mem_grant_mode", ["read", "write"]); // write implique read
export const entityReviewStatus = pgEnum("mem_entity_review_status", ["pending", "merged", "distinct"]);
export const ingestionStatus = pgEnum("mem_ingestion_status", [
  "PROPOSED",
  "APPLYING",
  "APPLIED",
  "PARTIAL",
  "REJECTED",
  "CHANGES_REQUESTED",
]);

// ── Column helpers ─────────────────────────────────────────────────────────
const pk = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ── Org (TENANT) + membership — inchangés vs v2 ───────────────────────────────
export const orgs = pgTable("mem_orgs", {
  id: pk(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  personalFor: text("personal_for").unique(), // org perso auto-provisionnée (sub) ; null = org normale
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "mem_memberships",
  {
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), // claim `sub`
    role: text("role").notNull().default("member"), // admin | member
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index("mem_memberships_user").on(t.userId)],
);

// ── Base : 1 par org (ADR 0003) — = la mémoire de l'org ───────────────────────
export const bases = pgTable("mem_bases", {
  id: pk(),
  orgId: uuid("org_id").notNull().unique().references(() => orgs.id, { onDelete: "restrict" }), // 1 base / org
  name: text("name").notNull(),
  createdAt: createdAt(),
});

// ── PAGE : seul nœud de structure ET de contenu (fusion Dossier+Page), un ARBRE ──
// prose pure : titre + description (1 phrase, sur la RACINE = la doctrine/HOW-TO) + corps.
// L'accès vient de la PAGE (visibilité + grants), hérité dans l'arbre (ADR 0003).
export const pages = pgTable(
  "mem_pages",
  {
    id: pk(),
    baseId: uuid("base_id").notNull().references(() => bases.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => pages.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""), // 1 phrase ; racine = Guide
    body: text("body").notNull().default(""), // prose markdown
    visibility: pageVisibility("visibility").notNull().default("org"), // public JAMAIS hérité (ADR 0003)
    ownerId: text("owner_id"), // sub du proprio (pour `private`)
    position: integer("position").notNull().default(0),
    depth: integer("depth").notNull().default(0),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    status: pageStatus("status").notNull().default("active"), // deprecated = exclue de la recherche
    clientKey: text("client_key"), // idempotence apply (unique par base)
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // body_fts tsvector(FR) : ajouté par migration SQL (cf. en-tête).
  },
  (t) => [
    index("mem_pages_base_parent_pos").on(t.baseId, t.parentId, t.position),
    uniqueIndex("mem_pages_base_client_key").on(t.baseId, t.clientKey),
  ],
);

// ── Page chunks : unité d'embedding pour la recherche sémantique ──────────────
// (re)chunké à l'apply/update. embedding halfvec + index HNSW partiel via migration SQL.
export const pageChunks = pgTable(
  "mem_page_chunks",
  {
    pageId: uuid("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    content: text("content").notNull(),
    modelVersion: text("model_version").notNull(),
    // embedding halfvec(<dim>) : ajouté par migration SQL.
  },
  (t) => [primaryKey({ columns: [t.pageId, t.idx] })],
);

// ── Sources (pointeurs / brut), attachées à une page (ou portion via locator) ──
export const sources = pgTable(
  "mem_sources",
  {
    id: pk(),
    baseId: uuid("base_id").notNull().references(() => bases.id, { onDelete: "cascade" }),
    kind: sourceKind("kind").notNull(),
    title: text("title").notNull(),
    citation: text("citation"),
    uri: text("uri"),
    content: text("content"),
    contentHash: text("content_hash"), // sha256 hex (dedup) — cf. fn content_hash
    trustLevel: integer("trust_level").notNull().default(1),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: createdAt(),
    // fts tsvector(FR) : ajouté par migration SQL.
  },
  (t) => [uniqueIndex("mem_sources_base_kind_uri_hash").on(t.baseId, t.kind, t.uri, t.contentHash)],
);

export const pageSources = pgTable(
  "mem_page_sources",
  {
    pageId: uuid("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
    locator: text("locator"), // ancrage sur une portion (span) de la page
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.sourceId] })],
);

// ── ENTITÉS : objet de 1er ordre, NIVEAU ORG (ADR 0002) ───────────────────────
// 2 familles : NER (personne/entreprise/outil, extraites serveur) + logique (decision, posée par l'agent).
// `attributes` jsonb porte les champs de la famille « événement » (decision) : status, occurred_at,
// supersedes (id de l'entité supersédée) — évite des colonnes vides à 95% des entités.
// SUPERSEDES n'a PAS de table dédiée (ADR 0002, D3) : pointeur dans attributes, ou link de span
// quand la cible « entité » des links de page sera tranchée (question ouverte ADR 0002).
export const entities = pgTable(
  "mem_entities",
  {
    id: pk(),
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    type: entityType("type").notNull(),
    canonicalLabel: text("canonical_label").notNull(),
    normalisedLabel: text("normalised_label").notNull(), // = normalise_name(canonical_label)
    aliases: text("aliases").array().notNull().default([]),
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "set null" }), // sa fiche (option)
    isStub: boolean("is_stub").notNull().default(true),
    attributes: jsonb("attributes"), // famille événement (decision): {status, occurred_at, supersedes}
    createdAt: createdAt(),
    // name_embedding halfvec(<dim>) : ajouté par migration SQL.
  },
  (t) => [
    uniqueIndex("mem_entities_org_type_norm").on(t.orgId, t.type, t.normalisedLabel), // anti-course / exact-match
  ],
);

// Backlinks : page ↔ entité (mention). span = portion du texte où elle apparaît.
export const mentions = pgTable(
  "mem_mentions",
  {
    pageId: uuid("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    span: text("span"),
    confidence: real("confidence"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.entityId] }), index("mem_mentions_entity").on(t.entityId)],
);

// ── Accès : grants par utilisateur sur une page (pas de groupes en v1, ADR 0003) ──
export const pageGrants = pgTable(
  "mem_page_grants",
  {
    id: pk(),
    baseId: uuid("base_id").notNull().references(() => bases.id, { onDelete: "cascade" }),
    pageId: uuid("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    mode: grantMode("mode").notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mem_page_grants_page_user").on(t.pageId, t.userId), index("mem_page_grants_user").on(t.userId)],
);

// ── Revue · Entités : suggestions de fusion de doublons (alimente la file) ─────
export const entityReviews = pgTable(
  "mem_entity_reviews",
  {
    id: pk(),
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    entityKeep: uuid("entity_keep").notNull().references(() => entities.id, { onDelete: "cascade" }),
    entityDrop: uuid("entity_drop").notNull().references(() => entities.id, { onDelete: "cascade" }),
    score: real("score"),
    method: text("method"), // trigram | jaro_winkler | knn | adjudicator
    status: entityReviewStatus("status").notNull().default("pending"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("mem_entity_reviews_org_status").on(t.orgId, t.status)],
);

// ── Ingestions (boucle propose→apply, idempotente) — adaptée base ─────────────
export const ingestions = pgTable(
  "mem_ingestions",
  {
    id: pk(),
    baseId: uuid("base_id").notNull().references(() => bases.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: ingestionStatus("status").notNull().default("PROPOSED"),
    proposal: jsonb("proposal").notNull(), // [{op, payload, class?, feedback?, edited?}] — ops v3 (create_page…)
    summary: text("summary").notNull().default(""),
    reviewNote: text("review_note"),
    clientKey: text("client_key"),
    createdBy: text("created_by"),
    decidedBy: text("decided_by"),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }), // lock CAS apply (#40)
  },
  (t) => [
    index("mem_ingestions_base_status").on(t.baseId, t.status),
    uniqueIndex("mem_ingestions_base_client_key").on(t.baseId, t.clientKey),
  ],
);

// ── Révisions (journal d'intention) — adaptée base ────────────────────────────
export const revisions = pgTable(
  "mem_revisions",
  {
    id: pk(),
    baseId: uuid("base_id").notNull().references(() => bases.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(), // page | entity | source | structure
    targetId: uuid("target_id"),
    op: text("op").notNull(),
    reason: text("reason").notNull(),
    actor: text("actor").notNull(),
    actorKind: text("actor_kind").notNull().default("human"),
    before: jsonb("before"),
    after: jsonb("after"),
    ingestionId: uuid("ingestion_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("mem_revisions_target").on(t.baseId, t.targetType, t.targetId, t.createdAt),
    index("mem_revisions_ingestion").on(t.ingestionId),
  ],
);

// ── Préférences / telemetry : reportées de v2 quasi inchangées ────────────────
// (mem_user_prefs default_base, mem_usage_logs, mem_agent_chat_log, mem_pinned_*)
// → à migrer mécaniquement (workspace→base) ; hors périmètre du contrat de modèle.
