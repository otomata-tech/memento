/**
 * Memento — schéma Drizzle canonique (tables `mem_*`). SOURCE UNIQUE partagée par
 * le runtime prod Deno (`supabase/functions/_shared/db.ts`) et l'outillage Node
 * (drizzle-kit, migrate, admin, seed, import). Aucune connexion ici : voir les db.ts.
 *
 * Multi-workspace : tout est scopé à un MemWorkspace. Les `targetId` polymorphes
 * (comments, revisions) n'ont pas de FK.
 */
import {
  pgTable,
  pgEnum,
  text,
  integer,
  timestamp,
  jsonb,
  uuid,
  primaryKey,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ── Enums ────────────────────────────────────────────────────────────────────
export const blockType = pgEnum("mem_block_type", [
  "PROSE",
  "PRINCIPE",
  "REGLE",
  "EXCEPTION",
  "EXEMPLE",
  "PROCEDURE",
  "MISE_EN_GARDE",
  "DEFINITION",
  "QUESTION",
  "PROMPT_PORTEUR",
  "PROMPT_SYSTEME",
]);
export const docStatus = pgEnum("mem_doc_status", ["ACTIVE", "DEPRECATED"]);
// Périmètre de partage d'une KB (issue #60) : `org` = tous les membres de l'org
// (rôle d'org en rôle par défaut) ; `private` = grants explicites seuls ;
// `public` = lisible/cherchable par TOUS (anonyme inclus) — l'org propriétaire
// garde son rôle (curate), le monde n'a que la lecture (cf. _shared/access.ts).
export const wsVisibility = pgEnum("mem_ws_visibility", ["org", "private", "public"]);
export const linkRelation = pgEnum("mem_link_relation", [
  "REFERENCES",
  "DEPENDS_ON",
  "CONTRADICTS",
  "SUPERSEDES",
  "RELATED",
]);
export const sourceKind = pgEnum("mem_source_kind", ["FILE", "URL", "MANUAL"]);
export const commentTarget = pgEnum("mem_comment_target", ["BLOCK", "DOCUMENT", "SECTION"]);
export const ingestionStatus = pgEnum("mem_ingestion_status", [
  "PROPOSED",
  "APPLIED",
  "REJECTED",
  "PARTIAL",
  "CHANGES_REQUESTED", // renvoyée à l'agent pour révision (ping-pong de revue)
]);

// ── Helpers colonnes ───────────────────────────────────────────────────────
const pk = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ── Org (TENANT) : annuaire de membres, propriétaire de workspaces ────────────
// L'org ne décide plus seule de l'accès (issue #60) : chaque KB porte son
// périmètre (visibility + grants). `personal_for` = org perso auto-provisionnée
// du user (sub) — l'« Alexis's Workspace » ; null = org normale.
export const orgs = pgTable("mem_orgs", {
  id: pk(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  personalFor: text("personal_for").unique(),
  createdAt: createdAt(),
});

// ── Appartenance : user Supabase (sub) ↔ org, avec rôle ───────────────────────
export const memberships = pgTable(
  "mem_memberships",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), // Supabase auth user id (claim `sub`)
    role: text("role").notNull().default("member"), // admin | member
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index("mem_memberships_user").on(t.userId),
  ],
);

// ── Workspace (KB) : appartient à une org, PORTE SON PÉRIMÈTRE de partage ────
export const workspaces = pgTable("mem_workspaces", {
  id: pk(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  summary: text("summary").notNull().default(""),
  orgId: uuid("org_id").references(() => orgs.id, { onDelete: "restrict" }), // org propriétaire (tenant)
  visibility: wsVisibility("visibility").notNull().default("org"),
  archivedAt: timestamp("archived_at", { withTimezone: true }), // null = active ; sinon masquée
  createdAt: createdAt(),
});

// ── Grants par KB : accès explicite d'un user à UNE KB (issue #60) ────────────
// Élève un membre (curator sur cette KB), restreint via private, ou invite un
// externe (guest) sans l'entrer dans l'org. Rôle effectif = max(grant, rôle
// d'org si visibility=org) — résolution dans _shared/access.ts.
export const workspaceGrants = pgTable(
  "mem_workspace_grants",
  {
    id: pk(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), // Supabase auth user id (claim `sub`)
    role: text("role").notNull().default("member"), // admin | curator | member
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mem_ws_grants_ws_user").on(t.workspaceId, t.userId),
    index("mem_ws_grants_user").on(t.userId),
  ],
);

// ── Sections (arbre récursif, par workspace) ──────────────────────────────────
export const sections = pgTable(
  "mem_sections",
  {
    id: pk(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => sections.id, {
      onDelete: "restrict",
    }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary").notNull().default(""),
    position: integer("position").notNull().default(0),
    depth: integer("depth").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("mem_sections_ws_parent_slug").on(t.workspaceId, t.parentId, t.slug),
    index("mem_sections_ws_parent_pos").on(t.workspaceId, t.parentId, t.position),
  ],
);

// ── Documents (conteneurs ordonnés de blocs) ──────────────────────────────────
export const documents = pgTable(
  "mem_documents",
  {
    id: pk(),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => sections.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary").notNull().default(""),
    kind: text("kind"),
    status: docStatus("status").notNull().default("ACTIVE"),
    position: integer("position").notNull().default(0),
    clientKey: text("client_key"), // clé d'idempotence (retry = no-op), unique par section
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("mem_documents_section_slug").on(t.sectionId, t.slug),
    index("mem_documents_section_pos").on(t.sectionId, t.position),
    uniqueIndex("mem_documents_section_client_key").on(t.sectionId, t.clientKey),
  ],
);

// ── Blocs (l'atome adressable) ─────────────────────────────────────────────────
export const blocks = pgTable(
  "mem_blocks",
  {
    id: pk(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    type: blockType("type").notNull().default("PROSE"),
    content: text("content").notNull().default(""),
    position: integer("position").notNull().default(0),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by"),
    clientKey: text("client_key"), // clé d'idempotence (retry = no-op), unique par document
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // search_vector tsvector : ajouté hors Drizzle par une migration SQL + trigger.
  },
  (t) => [
    index("mem_blocks_doc_pos").on(t.documentId, t.position),
    uniqueIndex("mem_blocks_doc_client_key").on(t.documentId, t.clientKey),
  ],
);

// ── Sources (autonomes, réutilisables) ─────────────────────────────────────────
export const sources = pgTable(
  "mem_sources",
  {
    id: pk(),
    kind: sourceKind("kind").notNull(),
    title: text("title").notNull(),
    ref: text("ref"), // FILE: clé de stockage · URL: l'URL · null si MANUAL
    citation: text("citation"),
    createdAt: createdAt(),
  },
  (t) => [index("mem_sources_kind").on(t.kind)],
);

export const blockSources = pgTable(
  "mem_block_sources",
  {
    blockId: uuid("block_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    locator: text("locator"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.blockId, t.sourceId] })],
);

// ── Liens transverses typés (la dose minimale de graphe) ───────────────────────
export const links = pgTable(
  "mem_links",
  {
    id: pk(),
    fromBlockId: uuid("from_block_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    toBlockId: uuid("to_block_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    relation: linkRelation("relation").notNull(),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mem_links_from_to_rel").on(t.fromBlockId, t.toBlockId, t.relation),
    index("mem_links_to").on(t.toBlockId),
  ],
);

// ── Commentaires (annotations humaines/agent, cible polymorphe) ────────────────
export const comments = pgTable(
  "mem_comments",
  {
    id: pk(),
    targetType: commentTarget("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    body: text("body").notNull(),
    author: text("author").notNull(),
    authorKind: text("author_kind").notNull().default("human"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("mem_comments_target").on(t.targetType, t.targetId)],
);

// ── Révisions (versioning avec motif = journal d'intention) ────────────────────
export const revisions = pgTable(
  "mem_revisions",
  {
    id: pk(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(), // block|document|section|link|structure
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
    index("mem_revisions_target").on(t.workspaceId, t.targetType, t.targetId, t.createdAt),
    index("mem_revisions_ingestion").on(t.ingestionId),
  ],
);

// ── Ingestions (boucle propose-valide matérialisée) ────────────────────────────
export const ingestions = pgTable(
  "mem_ingestions",
  {
    id: pk(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id"),
    title: text("title").notNull(),
    status: ingestionStatus("status").notNull().default("PROPOSED"),
    proposal: jsonb("proposal").notNull(), // [{op, target, payload, rationale, class, feedback?, edited?}]
    summary: text("summary").notNull().default(""),
    reviewNote: text("review_note"), // note de revue globale (humain → agent) lors d'un renvoi
    clientKey: text("client_key"), // clé d'idempotence (retry = no-op), unique par workspace
    createdBy: text("created_by"),
    decidedBy: text("decided_by"),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // Verrou d'apply (#40) : posé en tête d'applyIngestion par CAS atomique
    // (claim), libéré (NULL) à la fin. Empêche un apply concurrent/rejoué de
    // ré-exécuter le change-set → plus de duplication silencieuse.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (t) => [
    index("mem_ingestions_ws_status").on(t.workspaceId, t.status),
    uniqueIndex("mem_ingestions_ws_client_key").on(t.workspaceId, t.clientKey),
  ],
);

// ── Settings / doctrine éditable, par workspace ───────────────────────────────
export const settings = pgTable(
  "mem_settings",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // ex "doctrine.preamble"
    value: text("value").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

// ── Log d'usage : problèmes rencontrés par les agents avec l'outil lui-même ────
// Télémétrie produit, PAS du savoir KB : workspaceSlug est du texte libre (pas de
// FK) pour que le log passe toujours, même si le contexte est cassé/inexistant.
export const usageLogs = pgTable(
  "mem_usage_logs",
  {
    id: pk(),
    userId: text("user_id").notNull(), // Supabase auth user id (claim `sub`)
    workspaceSlug: text("workspace_slug"),
    verb: text("verb"), // verbe mem_* concerné, null si problème global
    kind: text("kind").notNull(), // bug | unexpected | missing | friction | docs | other
    summary: text("summary").notNull(),
    detail: text("detail"),
    createdAt: createdAt(),
  },
  (t) => [
    index("mem_usage_logs_user").on(t.userId, t.createdAt),
    index("mem_usage_logs_ws").on(t.workspaceSlug, t.createdAt),
  ],
);

// ── Préférences utilisateur : KB par défaut (sub Supabase → workspace) ─────────
export const userPrefs = pgTable("mem_user_prefs", {
  userId: text("user_id").primaryKey(), // Supabase auth user id (claim `sub`)
  defaultWorkspaceId: uuid("default_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

// ── KB épinglées : la collection de KB (typiquement publiques d'autres orgs) qu'un
// user garde dans son univers — distinct de la KB par défaut (userPrefs, unique).
// Remontées dans contextMap.pinned et couvertes par mem_search(workspace:"*").
export const pinnedWorkspaces = pgTable(
  "mem_pinned_workspaces",
  {
    userId: text("user_id").notNull(), // Supabase auth user id (claim `sub`)
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

