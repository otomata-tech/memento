# Memento — founding spec (structured knowledge base, MCP-first)

> **Memento** — *memento mori, note everything.* A **structured, sourced, living
> and auditable** knowledge substrate, consumed by agents via MCP. Where a
> document RAG stores a bag of documents, Memento represents **know-how**:
> concepts, rules, exceptions, procedures — linked, sourced, and kept current by
> a propose-validate loop.
>
> **Fresh start** (2026-05-29). Memento **does not reuse** the code of the old
> Mento (`mento.cc` — a docs portal backed by GitHub repos, Flask/React):
> opposite philosophy (git files + a graph derived from links vs first-class
> blocks in DB). We keep **the name** and the "note everything" intent.
>
> **Multi-workspace**: Memento is multi-project by nature (the cross-cutting
> knowledge substrate of all your projects). Each workspace has its own
> doctrine. **Demo KB / Kairos AI = workspace #1** (cf. memory
> `project_kairos_ai_strategy`). "Integrate into my projects" = each project/
> agent consumes the Memento MCP — exactly what the old Mento already did,
> wired everywhere.

Status: **living spec, implemented** (Lots 1–5 delivered, prod `mento.cc`).
Prefix `mem_`. The implementation is authoritative: canonical schema
`server/src/schema.ts` (Drizzle), MCP surface `supabase/functions/mcp/index.ts`.
The backlog lives in the repo's **GitHub issues**, plus in this document.

---

## 1. Positioning

**Standalone product.** Its own data model, surface and deployment. No FK nor
shared table with the consuming projects (example-kb, etc.).

- **Interop via MCP only.** Memento exposes its `mem_*` verbs to agents
  (Claude Desktop, Claude Code, claude.ai, future Kairos AI agents). An agent can
  simultaneously consume a project's MCP (e.g. example-kb) **and** the Memento MCP
  to cross business data with doctrine. Coupling stops at the protocol.
- **Multi-workspace = multi-tenant.** A `MemWorkspace` = a project/knowledge
  domain, isolated. Access is governed by the owning org (`mem_orgs` +
  `mem_memberships` — cf. `docs/access-control.md`). Demo KB is the first.
- **The old Mento is not the starting point.** Its content (markdown docs in
  git repos) can serve as a *content donor* at bootstrap (§9), not as a base.

Core value — what no off-the-shelf product gives: the **block** as an
addressable entity, a **section backbone** per workspace, **typed cross-cutting
links**, **sourcing at block grain**, **comments**, a **verification status**,
**versioning with a reason**, and the **propose-validate** ingestion loop.

---

## 2. Guiding principles

1. **Dumb server, smart agent.** The MCP stores, guarantees invariants
   (invalid states are impossible) and journals intent. Claim extraction and
   impact judgment are done by the calling agent (Claude). **No LLM on the
   server side.**
2. **Doctrine-first.** The entry point `mem_doctrine({workspace})` returns a
   compact map (always loadable) + the usage meta-instructions. It is the
   `get_claude_md` equivalent of GR/Blitz, per workspace.
3. **Propose, never self-applies.** Every restructuring and every ingestion goes
   through a `dryRun` / a `MemIngestion` object reviewed by a human.
   **Contradictions** are the precious case: never auto-applied.
4. **Anchoring that survives.** Each doctrine-bearing block points to the
   source(s) that justify it. Auditable after N reorganizations.
5. **Constraint at the top, freedom at the bottom.** Strict, shallow section
   hierarchy (backbone); free composition of typed blocks within documents.
6. **The block is the fine grain.** Sources/comments/links attach to the whole
   block. A block that would need two sources for two statements must be split
   into two blocks (no intra-block annotation → no Portable Text).
7. **Per-workspace isolation.** Access governed by membership in the workspace's
   owning org (in-house orgs/memberships, admin/curator/member roles —
   `docs/access-control.md`). An org = a **sharing perimeter** (mission/client,
   personal). Internal asset: no public exposure in v1.

---

## 3. Data model

Rendered below in pseudo-**Prisma** for readability. **The implementation is
authoritative**: Drizzle/PostgreSQL in `server/src/schema.ts` (canonical schema,
`mem_*` tables, imported by both runtimes). Any relational store works; the model
is agnostic. On the access side this adds: `mem_orgs`, `mem_memberships`,
`mem_user_prefs` (default KB) — cf. `docs/access-control.md`.

```prisma
enum MemBlockType {
  PROSE
  PRINCIPE
  REGLE
  EXCEPTION
  EXEMPLE
  PROCEDURE
  MISE_EN_GARDE
  DEFINITION
  QUESTION
  PROMPT_PORTEUR   // cf. target "tool sheet" format (prompt aimed at the lead)
  PROMPT_SYSTEME   // guardrails / sub-agent lessons learned
}

enum MemDocStatus      { ACTIVE DEPRECATED }  // no draft: the "not yet validated" lives in MemIngestion (PROPOSED), cf. #59
enum MemLinkRelation   { REFERENCES DEPENDS_ON CONTRADICTS SUPERSEDES RELATED }
enum MemSourceKind     { FILE URL MANUAL }
enum MemCommentTarget  { BLOCK DOCUMENT SECTION }
enum MemIngestionStatus{ PROPOSED APPLIED REJECTED PARTIAL }

// ── Workspace: the tenant. An isolated knowledge domain (Demo KB = #1) ────
model MemWorkspace {
  id        String   @id @default(cuid())
  slug      String   @unique           // URL/MCP identifier ("example-kb")
  name      String
  summary   String   @default("")
  orgId     String?  @map("org_id")     // owning org (mem_orgs) — governs access
  archivedAt DateTime? @map("archived_at") // reversible archive (hides the KB)
  createdAt DateTime @default(now()) @map("created_at")

  sections MemSection[]
  @@map("mem_workspaces")
}

// ── Backbone: section tree (shallow, constrained), per workspace ──────────
model MemSection {
  id          String   @id @default(cuid())
  workspaceId String   @map("workspace_id")
  parentId    String?  @map("parent_id")
  title       String
  slug        String
  summary     String   @default("")   // short — feeds the map/doctrine + brief
  position    Int      @default(0)
  depth       Int      @default(0)     // denormalized, maintained in service (depth invariant)
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt      @map("updated_at")

  workspace MemWorkspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  parent    MemSection?  @relation("MemSectionTree", fields: [parentId], references: [id], onDelete: Restrict)
  children  MemSection[] @relation("MemSectionTree")
  documents MemDocument[]

  @@unique([workspaceId, parentId, slug])
  @@index([workspaceId, parentId, position])
  @@map("mem_sections")
}

// ── Editorial container: a document = an ordered sequence of blocks ──────────
model MemDocument {
  id        String       @id @default(cuid())
  sectionId String       @map("section_id")
  title     String
  slug      String
  summary   String       @default("")
  kind      String?                          // free: "outil", "methode", "concept", "playbook"
  status    MemDocStatus @default(ACTIVE)
  position  Int          @default(0)
  createdBy String?      @map("created_by")
  updatedBy String?      @map("updated_by")
  createdAt DateTime     @default(now()) @map("created_at")
  updatedAt DateTime     @updatedAt      @map("updated_at")

  section MemSection @relation(fields: [sectionId], references: [id], onDelete: Restrict)
  blocks  MemBlock[]

  @@unique([sectionId, slug])
  @@index([sectionId, position])
  @@map("mem_documents")
}

// ── The addressable atom ─────────────────────────────────────────────────────
model MemBlock {
  id         String       @id @default(cuid())
  documentId String       @map("document_id")
  type       MemBlockType @default(PROSE)
  content    String                          // markdown
  position   Int          @default(0)
  verifiedAt DateTime?    @map("verified_at") // confidence status (inspired by Slite)
  verifiedBy String?      @map("verified_by")
  createdBy  String?      @map("created_by")
  updatedBy  String?      @map("updated_by")
  createdAt  DateTime     @default(now()) @map("created_at")
  updatedAt  DateTime     @updatedAt      @map("updated_at")
  // search_vector tsvector — outside the DSL, maintained by trigger (cf. §7)

  document  MemDocument     @relation(fields: [documentId], references: [id], onDelete: Cascade)
  sources   MemBlockSource[]
  linksFrom MemLink[]       @relation("MemLinkFrom")
  linksTo   MemLink[]       @relation("MemLinkTo")

  @@index([documentId, position])
  @@map("mem_blocks")
}

// ── Sources: standalone, reusable entities. Proper file storage. ─────────────
model MemSource {
  id        String        @id @default(cuid())
  kind      MemSourceKind
  title     String
  ref       String?                             // FILE: internal storage key · URL: the URL · null if MANUAL
  citation  String?                             // "Groff, Boîte à outils créativité, 4th ed., p.42"
  createdAt DateTime      @default(now()) @map("created_at")

  blocks MemBlockSource[]
  @@index([kind])
  @@map("mem_sources")
}

model MemBlockSource {
  blockId   String   @map("block_id")
  sourceId  String   @map("source_id")
  locator   String?                       // page, anchor, span cited in the source
  createdAt DateTime @default(now()) @map("created_at")

  block  MemBlock  @relation(fields: [blockId], references: [id], onDelete: Cascade)
  source MemSource @relation(fields: [sourceId], references: [id], onDelete: Restrict)

  @@id([blockId, sourceId])
  @@map("mem_block_sources")
}

// ── The minimal dose of graph: typed cross-cutting block↔block links ─────────
model MemLink {
  id          String          @id @default(cuid())
  fromBlockId String          @map("from_block_id")
  toBlockId   String          @map("to_block_id")
  relation    MemLinkRelation
  note        String?                        // why this link
  createdBy   String?         @map("created_by")
  createdAt   DateTime        @default(now()) @map("created_at")

  fromBlock MemBlock @relation("MemLinkFrom", fields: [fromBlockId], references: [id], onDelete: Cascade)
  toBlock   MemBlock @relation("MemLinkTo",   fields: [toBlockId],   references: [id], onDelete: Cascade)

  @@unique([fromBlockId, toBlockId, relation])
  @@index([toBlockId])
  @@map("mem_links")
}

// ── Annotations (the Notion principle) — human or agent ─────────────────────
model MemComment {
  id         String           @id @default(cuid())
  targetType MemCommentTarget
  targetId   String           @map("target_id")
  body       String
  author     String                                  // user id or agent name
  authorKind String           @default("human") @map("author_kind") // human | agent
  resolvedAt DateTime?         @map("resolved_at")
  createdAt  DateTime          @default(now()) @map("created_at")

  @@index([targetType, targetId])
  @@map("mem_comments")
}

// ── Versioning with a reason (the "git diff" becomes a journal of intent) ────
model MemRevision {
  id          String   @id @default(cuid())
  workspaceId String   @map("workspace_id")
  targetType  String   @map("target_type")  // block|document|section|link|structure
  targetId    String?  @map("target_id")
  op          String                          // create|update|move|delete|set_type|verify|link|unlink|split_section|merge_sections|deprecate
  reason      String
  actor       String
  actorKind   String   @default("human") @map("actor_kind")
  before      Json?
  after       Json?
  ingestionId String?  @map("ingestion_id")
  createdAt   DateTime @default(now()) @map("created_at")

  @@index([workspaceId, targetType, targetId, createdAt])
  @@index([ingestionId])
  @@map("mem_revisions")
}

// ── Materialized propose-validate loop: a proposed, reviewed, applied change-set
model MemIngestion {
  id          String             @id @default(cuid())
  workspaceId String             @map("workspace_id")
  sourceId    String?            @map("source_id") // the source triggering the ingestion
  title       String
  status      MemIngestionStatus @default(PROPOSED)
  proposal    Json                                  // [{op, target, payload, rationale, class}]
  summary     String             @default("")
  createdBy   String?            @map("created_by")
  decidedBy   String?            @map("decided_by")
  createdAt   DateTime           @default(now()) @map("created_at")
  decidedAt   DateTime?          @map("decided_at")

  @@index([workspaceId, status])
  @@map("mem_ingestions")
}

// ── Editable doctrine + config, per workspace (key/value) ───────────────────
model MemSetting {
  workspaceId String   @map("workspace_id")
  key         String                         // e.g. "doctrine.preamble"
  value       String
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@id([workspaceId, key])
  @@map("mem_settings")
}
```

---

## 4. Invariants (invalid states are impossible)

Guaranteed in service (transaction) — some doubled by a DB constraint.

- **Workspace scoping**: sections, documents, blocks, revisions, ingestions, settings
  belong to exactly one workspace; no relation crosses two workspaces
  (e.g. a `MemLink` links two blocks of the **same** workspace).
- **Section tree**: depth ≤ 3 (to confirm, §11), no cycle in the
  `parentId` chain, `slug` unique among siblings of the same workspace
  (`@@unique([workspaceId, parentId, slug])`).
- **Document**: `slug` unique within its section; attached to exactly one section;
  a section can hold both subsections **and** documents simultaneously.
- **Block**: belongs to exactly one document; `position` ordered within the doc.
- **Link**: no self-reference (`from ≠ to`); unique `(from, to, relation)`;
  both blocks exist (same workspace). A `SUPERSEDES` **proposes** (never
  applies) moving the target document/block to `DEPRECATED`.
- **Source**: `FILE ⇒ ref` (storage key); `URL ⇒ ref`; `MANUAL ⇒ citation`.
- **Mutation**: every mutating verb requires a non-empty `reason` → writes a `MemRevision`.
- **Restructuring**: atomic; leaves no empty section unless `allowEmpty`.
- **Ingestion**: `apply` only acts on a `PROPOSED` `MemIngestion`; all-or-`PARTIAL`
  transaction (per `acceptIds`); writes one `MemRevision` per applied op
  (with `ingestionId`).

---

## 5. MCP surface (`mem_*`)

**42 verbs in prod** — the implementation is authoritative (`supabase/functions/mcp/index.ts`).
All verbs are **scoped to a workspace**, resolved in this order: explicit
`workspace` slug > the user's **default KB** (`mem_use_workspace`, persisted
in `mem_user_prefs`); or a `path` prefixed `workspace/section/...` (slugified path,
e.g. `example-kb/strategie/creativite`). Responses return the KB used.

**Role gating** (cf. `docs/access-control.md`):
- *read*: any member of the owning org;
- *write, structure, loop*: `curator`/`admin` (`assertAccess {write:true}`);
- *archive / KB creation*: **org admin** (`assertWorkspaceAdmin` / `mem_create_workspace`).
- the propose-validate loop is **recommended** (server instructions), not imposed on a
  curator — a "proposer" role that would impose it is tracked in issue #7.

### 5.0 Workspaces, orgs & doctrine

```ts
mem_workspaces()   // CONTEXT MAP: orgs (your role) → KB, + default KB (`default`)
mem_use_workspace({ workspace })       // sets the default KB (persisted per user)
mem_orgs()                             // the caller's orgs: role, members, KB — to choose where to create
mem_create_org({ name, slug? })        // creates a sharing perimeter; the creator becomes admin
mem_create_workspace({ org, name, summary?, slug? })  // org-admin; slug derived from the name if omitted
mem_transfer_workspace({ workspace, toOrg })          // admin of BOTH orgs; changes the sharing perimeter
mem_set_doctrine({ workspace?, preamble })            // writes the preamble (MemSetting "doctrine.preamble")
mem_update_workspace({ workspace?, name?, summary? }) // metadata; the slug stays stable
mem_archive_workspace({ workspace?, archived? })      // org-admin; reversible (archived:false)
```

### 5.1 Entry & reading (the server never returns an unrequested wall of text)

```ts
mem_doctrine({ workspace? })
// { usedWorkspace, preamble, tree, conventions }
// preamble  : editable meta-instructions (the workspace's MemSetting "doctrine.preamble") —
//             how the base is organized, when to use each block type,
//             the verb usage protocol, the propose-validate rule.
// tree      : section tree (title + summary + doc/block counters), WITHOUT content.
// conventions: MemBlockType + MemLinkRelation enums, enumerated for the agent.

mem_section({ id | path })
// unfolds a zone: subsections + documents (title, summary, status, counters). No blocks.

mem_document({ id | path })
// full document: ordered blocks (id, type, content) + sources + links + comments.

mem_block({ id })
// a block + its sources/links/comments (surgical inspection).

mem_neighborhood({ blockId, depth?, relations?, direction? })
// link-graph traversal: subgraph at depth hops (1-3, default 1, cap 200 nodes).
// nodes = blocks (excerpt + document/section + depth), edges = typed links.
// direction out|in|both ; relations = filter. Then drill with mem_block. (issue #17)

mem_search({ q? | likeBlockId?, workspace?, mode?, blockType?, sectionPath?, docKind?, maxHits? })
// THE search, HYBRID by default: full-text FR (tsvector, cf. §7) + semantic (kNN
// pgvector, embeddings computed at write time), RRF fusion. matchedBy per hit.
// workspace:"*" = global over all accessible KBs (hits labeled {workspace, org}).
// likeBlockId = blocks close to an anchor block (dedup, link suggestions, ingestion targeting).
// mode lexical|semantic forces a regime; embedding unavailable → degrades to lexical, flagged
// (`modes`). NULLs ignored (backfill: npm run embed:backfill).

mem_revisions({ workspace?, targetType?, targetId?, limit? })
// journal of mutations (op, reason, actor, before/after), newest to oldest.
```

(Direct links are read in `mem_document`/`mem_block`, multi-hop via
`mem_neighborhood`; a source-discovery verb, `mem_sources`, is tracked in issue #11.)

### 5.2 Atomic writing

```ts
mem_add_document({ sectionId, title, summary?, kind?, blocks?, reason? })
// blocks : TWO doors —
//   (a) raw markdown → auto-split into blocks (## → boundaries, paragraphs → PROSE),
//       the agent refines the types afterwards;
//   (b) array [{ type, content }] → fine control (sources attached per block afterwards).

mem_add_block({ documentId, type, content, position?, reason? })
mem_update_block({ id, content?, type?, reason })          // reason mandatory
mem_set_block_type({ id, type, reason })
mem_move_block({ id, toDocumentId?, position?, reason })   // without position: to the end
mem_delete_block({ id, reason })                           // snapshot kept in the revision

mem_attach_source({ blockId, sourceId? | kind+title+ref?/citation?, locator?, reason? })
// reuses an existing source (sourceId) OR creates it on the fly — no separate mem_add_source
mem_detach_source({ blockId, sourceId, reason? })          // detaches the link, not the source

mem_link_blocks({ fromId, toId, relation, note?, reason? })
mem_unlink({ linkId, reason? })

mem_comment({ targetType, targetId, body, authorKind? })   // BLOCK|DOCUMENT|SECTION
mem_resolve_comment({ id })

mem_verify_block({ id, verified?, reason? })   // sets verifiedAt/By ; verified:false removes
```

### 5.3 Restructuring (composite, atomic, `dryRun`)

Op-based verbs = auditable intent ("split 3.2", not 4 micro-moves), `op` selecting the action.
Composites accept `dryRun: true` → return the before/after diff + impact, without mutating.

```ts
// sections: one verb, op = create | rename | delete | split | merge
mem_section_op({ op, workspace?, id?, parentId?, title?, summary?, slug?, position?,
                 reason?, cascade?, newSectionTitle?, documentIdsToMove?[], sourceIds?[], targetId?, dryRun? })
//   create → parentId? (root if absent), title, summary?, position?, workspace?   // depth ≤ 3
//   rename → id, title?, summary?; slug stable unless `slug` passed (re-slugs → path CHANGES)
//   delete → id, reason? (EMPTY section); cascade:true → HARD-delete the whole subtree
//   split  → id, newSectionTitle, documentIdsToMove[]
//   merge  → sourceIds[], targetId
mem_move({ op, ... })                              // op = documents | section ; same-KB & cross-KB one path
//   documents → documentIds[], targetSectionId, dryRun?
//   section   → sectionId, targetWorkspace, targetParentId?, dryRun?
mem_reorder({ parentId?, orderedChildIds[] })      // sections of a parent OR docs of a section
mem_document_op({ op, id, title?, summary?, reason? })   // op = update | delete (metadata / hard-delete)
mem_deprecate_document({ id, supersededBy?, reason })   // obsolescence (status → DEPRECATED) — op of mem_stage_changes
```

### 5.4 Ingestion loop (proposed change-set → reviewed → applied)

The intelligence is in the agent; these verbs only **store the intent**
and **apply under invariants**.

```ts
mem_stage_changes({ workspace?, sourceId?, title, summary?, changes[] })
// changes[] = [{ op, payload, class?, target?, rationale? }]
//   op    : add_document | add_block | update_block | set_block_type | delete_block |
//           attach_source | detach_source | verify_block | move_block | link_blocks |
//           deprecate_document    (payload = the corresponding verb's arguments)
//   class : CONFIRM | ENRICH | CONTRADICT | OBSOLETE   (the diff classification)
// → creates a PROPOSED MemIngestion. Nothing is mutated.

mem_ingestion_get({ id })       // human review: the classified diff op by op + applied/error state
mem_ingestion_list({ workspace?, status? })
mem_apply_ingestion({ id, acceptIds? })
// without acceptIds: applies everything EXCEPT the CONTRADICTs (held pending);
// with acceptIds: that subset only (→ APPLIED if all pass, otherwise PARTIAL).
// One MemRevision per applied op, linked to the ingestionId.
mem_reject_ingestion({ id, reason? })     // → REJECTED
```

---

## 6. The ingestion loop, walked through

When a new source arrives (PDF, note, lessons learned):

1. **Conversion** — PDF/DOCX → markdown via a converter (openkairos-agent's
   `ingest.py` tool does the job, without depending on it), then the agent extracts the claims.
2. **Targeting** — `mem_doctrine({workspace})` → the agent identifies the 2-3 relevant sections.
3. **Targeted loading** — `mem_section`/`mem_document` on those zones only (the
   context window is the real wall, not time — we never load everything).
4. **Block-grain diff** — for each claim, the agent classifies vs existing blocks:
   - `CONFIRM` → `attach_source` on an existing block (reinforces, adds a source);
   - `ENRICH` → `add_block` (new node);
   - `CONTRADICT` → `link_blocks(..., CONTRADICTS)` + **escalation to the expert** (never auto);
   - `OBSOLETE` → `deprecate_document` / `link_blocks(..., SUPERSEDES)`.
5. **Staging** — `mem_stage_changes({ workspace, sourceId, changes })` → PROPOSED `MemIngestion`.
6. **Human review** — `mem_ingestion_get`; the expert accepts/rejects per op.
7. **Application** — `mem_apply_ingestion`: transactional, one `MemRevision` per op,
   linked to the `ingestionId`. Reversible via the `before/after` snapshots.

> Anti-drift guardrail: if two ingestions touch the same section in subtly
> incompatible ways, the PROPOSED `MemIngestion` makes the collision visible
> before application. At low volume we are far from the regime where it oscillates.

---

## 7. Block format & search

- **`MemBlock.content` = markdown.** No Portable Text: its inline *marks* serve
  human rich-text editing; here the annotations (source/comment/link) attach to
  the whole block, relationally — far more queryable (SQL/Drizzle) and easy to
  reason about for an agent. Escape hatch if one day we want intra-block,
  span-level annotation: shrink block size further before reintroducing a rich
  format.
- **Search**: full-text per block. Postgres `search_vector tsvector` + config
  `french_unaccent` maintained by a **trigger** (outside the ORM DSL → raw SQL
  query; `unaccent` extension required). Embeddings / semantic search = possible
  v2, not v1.

---

## 8. Topology & access

*(Section rewritten post-implementation — the original topology, Fastify + Logto +
tuls.me, has been replaced. Operational details: `docs/deployment-edge.md` and
`docs/access-control.md`.)*

- **Standalone service**: `/data/projects/memento`, its own git repo, its own
  deployment. **Single runtime = Supabase Edge Functions (Deno)**: an `mcp`
  function (MCP server, official `@modelcontextprotocol/sdk`, stateless Streamable
  HTTP) and an `api` function (REST read mirror for the viewer), both thin over a
  single service layer (`supabase/functions/_shared/`). Vue 3 viewer (`app/`) — no
  WYSIWYG block-editing UI in v1.
- **Auth: Supabase Auth** — OAuth 2.1 + DCR server; the MCP function is an RFC
  9728 resource server (PRM, `WWW-Authenticate`, ES256 JWKS verification). (Logto
  dropped along the way — Supabase covers OAuth + DB + Edge under a single tenant.)
- **Access**: in-house orgs/memberships (`mem_orgs`, `mem_memberships`), a workspace
  belongs to an org, admin/curator/member roles. An org = a sharing perimeter.
- **Interop**: agent → MCP connector (claude.ai, Claude Code). Never DB sharing;
  the Supabase Data API (PostgREST) is **cut off**, everything goes through the functions.
- **Deployment**: prod `mento.cc` — frontend **Cloudflare Pages** (the SPA + Pages
  Functions proxying `/mcp`·`/api`·`/.well-known` → Supabase), backend Supabase.
  Auto-deploy on `main` push. Possible takeover of `mento.cc` + the old Mento's
  global MCP slot: later.

---

## 9. Corpus bootstrap (optional, decoupled)

So as not to start empty, you can **import** existing content — that's a *data
entry*, not a coupling. First targeted workspace: **Demo KB** (Arnaud's docs:
creativity, Chinese strategy, eco-design). A standalone importer:

1. Fetches the docs (markdown already converted, or PDF → markdown via a converter);
   each source file → one `MemSource` (`kind=FILE`/`URL` + `citation`).
2. Splits the markdown (a heading parser like `parseOutline` works):
   headings → `MemSection`, paragraphs → `MemBlock` (`PROSE` by default).
3. Attaches the `MemSource` to the blocks (coarse initial sourcing, refined later by
   hand / by the loop).

This is a **bootstrap**, not a frozen truth. Any other source (notes, lessons
learned, exports from another project) enters via the same path.

---

## 10. Build order — **all lots delivered** ✅

- **Lot 0 — Framing** ✅ (2026-05-29): Memento project, stack, multi-workspace.
- **Lot 1 — Read foundation** ✅: tables + bootstrap + `mem_workspaces/doctrine/section/document/block/search`.
- **Lot 2 — Curated writing** ✅: `add_document` (2 doors), blocks, sources, `verify_block`, `MemRevision`.
- **Lot 3 — Linking & annotation** ✅: `link_blocks/unlink`, `comment/resolve_comment`.
- **Lot 4 — Restructuring** ✅: sections (create/rename/delete/split/merge), `move_documents`, `reorder`, `deprecate_document` — composites with `dryRun`.
- **Lot 5 — Ingestion loop** ✅: `MemIngestion` + `stage_changes/ingestion_get/list/apply/reject`.

Added beyond the lots: **Supabase Edge** port + prod `mento.cc`,
orgs/memberships access control, default KB (`mem_use_workspace`), KB management
(doctrine/update/archive/create + `mem_orgs`), admin UI (members, link invitation,
KB creation), enriched viewer (journal, ingestions, links/sources/comments).

**What's next is planned in the repo's GitHub issues** (#7 proposer role, #8 claude.ai
connector, #9 JB onboarding, #10 semantic search, #11 `mem_sources`, #12–#14 docs).

---

## 11. Decisions — settled and open

**Settled (implemented)**:
- **Max section depth = 3** (enforced in `_shared/restructure.ts`).
- **A section can be both a parent and a document holder**: yes.
- **Auth**: Logto → **Supabase Auth OAuth 2.1 + DCR** (§8, `docs/deployment-edge.md`).
- **Access**: Logto Organizations → **in-house orgs/memberships**; an org = a sharing
  perimeter (`docs/access-control.md`).
- **KB granularity = sharing perimeter** (one per mission/client + personal), not per
  repo, no general KB.

**Open**:
- **Initial section taxonomy** (Demo KB workspace) = an **Arnaud/Cyril** decision,
  not technical. The schema hardwires **no** category: the tree is data.
- **`MemBlockType` vocabulary**: to validate against a real corpus before freezing the
  enum — risk of over- or under-typing.
- **Takeover of `mento.cc`** + the old Mento's global MCP slot: to plan.
- **Semantic search / embeddings**: issue #10.
- **"Proposer" role** (imposing the propose-validate loop on agents): issue #7.
