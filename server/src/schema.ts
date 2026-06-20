/**
 * Memento — canonical Drizzle schema (`mem_*` tables). SINGLE SOURCE shared by
 * the Deno prod runtime (`supabase/functions/_shared/db.ts`) and the Node tooling
 * (drizzle-kit, migrate, admin, seed, import). No connection here: see the db.ts files.
 *
 * Multi-workspace: everything is scoped to a MemWorkspace. The polymorphic `targetId`s
 * (comments, revisions) have no FK.
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
// Sharing scope of a KB (issue #60): `org` = all members of the org
// (org role as default role); `private` = explicit grants only;
// `public` = readable/searchable by EVERYONE (anonymous included) — the owning org
// keeps its role (curate), the world only gets read access (cf. _shared/access.ts).
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
  "CHANGES_REQUESTED", // sent back to the agent for revision (review ping-pong)
]);

// ── Column helpers ─────────────────────────────────────────────────────────
const pk = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ── Org (TENANT): member directory, owner of workspaces ───────────────────────
// The org no longer decides access on its own (issue #60): each KB carries its own
// scope (visibility + grants). `personal_for` = the user's (sub) auto-provisioned
// personal org — the "Alexis's Workspace"; null = normal org.
export const orgs = pgTable("mem_orgs", {
  id: pk(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  personalFor: text("personal_for").unique(),
  createdAt: createdAt(),
});

// ── Membership: Supabase user (sub) ↔ org, with role ──────────────────────────
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

// ── Workspace (KB): belongs to an org, CARRIES ITS sharing SCOPE ──────────────
export const workspaces = pgTable("mem_workspaces", {
  id: pk(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  summary: text("summary").notNull().default(""),
  orgId: uuid("org_id").references(() => orgs.id, { onDelete: "restrict" }), // owning org (tenant)
  visibility: wsVisibility("visibility").notNull().default("org"),
  archivedAt: timestamp("archived_at", { withTimezone: true }), // null = active; otherwise hidden
  createdAt: createdAt(),
});

// ── Per-KB grants: a user's explicit access to ONE KB (issue #60) ─────────────
// Elevates a member (curator on this KB), restricts via private, or invites an
// external (guest) without adding them to the org. Effective role = max(grant, org
// role if visibility=org) — resolved in _shared/access.ts.
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

// ── Sections (recursive tree, per workspace) ──────────────────────────────────
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

// ── Documents (ordered containers of blocks) ──────────────────────────────────
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
    clientKey: text("client_key"), // idempotency key (retry = no-op), unique per section
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

// ── Blocks (the addressable atom) ──────────────────────────────────────────────
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
    clientKey: text("client_key"), // idempotency key (retry = no-op), unique per document
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // search_vector tsvector: added outside Drizzle by a SQL migration + trigger.
  },
  (t) => [
    index("mem_blocks_doc_pos").on(t.documentId, t.position),
    uniqueIndex("mem_blocks_doc_client_key").on(t.documentId, t.clientKey),
  ],
);

// ── Sources (standalone, reusable) ─────────────────────────────────────────────
export const sources = pgTable(
  "mem_sources",
  {
    id: pk(),
    kind: sourceKind("kind").notNull(),
    title: text("title").notNull(),
    ref: text("ref"), // FILE: storage key · URL: the URL · null if MANUAL
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

// ── Typed cross-cutting links (the minimal dose of graph) ──────────────────────
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

// ── Comments (human/agent annotations, polymorphic target) ─────────────────────
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

// ── Revisions (versioning with reason = intent journal) ────────────────────────
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

// ── Ingestions (the propose-validate loop, materialized) ───────────────────────
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
    reviewNote: text("review_note"), // global review note (human → agent) on a send-back
    clientKey: text("client_key"), // idempotency key (retry = no-op), unique per workspace
    createdBy: text("created_by"),
    decidedBy: text("decided_by"),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // Apply lock (#40): set at the top of applyIngestion by an atomic CAS
    // (claim), released (NULL) at the end. Prevents a concurrent/replayed apply
    // from re-executing the change-set → no more silent duplication.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (t) => [
    index("mem_ingestions_ws_status").on(t.workspaceId, t.status),
    uniqueIndex("mem_ingestions_ws_client_key").on(t.workspaceId, t.clientKey),
  ],
);

// ── Settings / editable doctrine, per workspace ───────────────────────────────
export const settings = pgTable(
  "mem_settings",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // e.g. "doctrine.preamble"
    value: text("value").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

// ── Usage log: problems agents hit with the tool itself ───────────────────────
// Product telemetry, NOT KB knowledge: workspaceSlug is free text (no FK) so the
// log always goes through, even if the context is broken/nonexistent.
export const usageLogs = pgTable(
  "mem_usage_logs",
  {
    id: pk(),
    userId: text("user_id").notNull(), // Supabase auth user id (claim `sub`)
    workspaceSlug: text("workspace_slug"),
    verb: text("verb"), // mem_* verb concerned, null if global problem
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

// ── Agent chat log: full transcript of public "agent mode" exchanges ───────────
// One row per turn (question + agent reply + retrieval/cost metadata). Lets a KB's
// curators see what people ask and where the agent fails (FAQ gaps). No raw IP:
// a salted hash for abuse correlation only.
export const agentChatLog = pgTable(
  "mem_agent_chat_log",
  {
    id: pk(),
    workspaceSlug: text("workspace_slug").notNull(),
    org: text("org"),
    sub: text("sub"), // null when anonymous
    ipHash: text("ip_hash"), // sha-256(ip + salt), never the raw IP
    question: text("question").notNull(),
    reply: text("reply"), // the agent's full answer
    hits: integer("hits"), // total search_kb results found across the turn
    searches: integer("searches"), // number of search_kb calls
    steps: integer("steps"),
    tokens: integer("tokens"),
    createdAt: createdAt(),
  },
  (t) => [index("mem_agent_chat_log_ws").on(t.workspaceSlug, t.createdAt)],
);

// ── User preferences: default KB (Supabase sub → workspace) ───────────────────
export const userPrefs = pgTable("mem_user_prefs", {
  userId: text("user_id").primaryKey(), // Supabase auth user id (claim `sub`)
  defaultWorkspaceId: uuid("default_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

// ── Pinned KBs: the collection of KBs (typically public ones from other orgs) a
// user keeps in their universe — distinct from the default KB (userPrefs, unique).
// Surfaced in contextMap.pinned and covered by mem_search(workspace:"*").
export const pinnedWorkspaces = pgTable(
  "mem_pinned_workspaces",
  {
    userId: text("user_id").notNull(), // Supabase auth user id (claim `sub`)
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

