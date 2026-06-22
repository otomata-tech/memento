/**
 * Memento MCP — Supabase Edge Function (Deno + official @modelcontextprotocol/sdk).
 * The 6 read verbs `mem_*`, on top of the shared services layer (`../_shared/`).
 *
 * Transport: WebStandardStreamableHTTPServerTransport (web Request/Response → compatible
 * with the Edge runtime). STATELESS (sessionIdGenerator: undefined): fresh server + transport
 * per request, suited to the Edge's ephemeral isolates. The `initialize` response is emitted as SSE
 * (text/event-stream) — required by claude.ai's MCP client (mcp-lite returned JSON,
 * hence the handshake failure).
 *
 * Local: DATABASE_URL=... deno run -A supabase/functions/mcp/index.ts
 * Deploy: supabase functions deploy mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { listWorkspaces, getDoctrine } from "../_shared/workspaces.ts";
import { getSection } from "../_shared/sections.ts";
import { getDocument, getBlock } from "../_shared/documents.ts";
import { hybridSearch, searchPublic } from "../_shared/search.ts";
import { listItems, countItems } from "../_shared/list.ts";
import { loadWorkspace, loadGate } from "../_shared/load.ts";
import { neighborhood } from "../_shared/graph.ts";
import { similarBlocks } from "../_shared/semantic.ts";
import { resolveWorkspaceBySlug, resolveWorkspaceById, resolveSectionIds } from "../_shared/paths.ts";
import { docUrl } from "../_shared/urls.ts";
import {
  authenticate,
  protectedResourceMetadata,
  wwwAuthenticate,
  isDiscoveryPath,
  authServerMetadata,
} from "../_shared/auth.ts";
import { assertAccess, assertWorkspaceAdmin, resolveWorkspaceId, AccessError, safeErrorMessage } from "../_shared/access.ts";
import { assertWithinLimit, RateLimitError } from "../_shared/ratelimit.ts";
import { setDefaultWorkspace, pinWorkspace, unpinWorkspace } from "../_shared/prefs.ts";
import { contextMap, wsContext, accessibleWorkspaceRefs } from "../_shared/context.ts";
import { setDoctrine, updateWorkspace, archiveWorkspace } from "../_shared/workspace_mgmt.ts";
import { listMyOrgs, createWorkspace, createOrg, updateOrg, transferWorkspace, deleteWorkspace } from "../_shared/admin.ts";
import { listGrants, grantAccess, revokeGrant, setVisibility } from "../_shared/grants.ts";
import { listAccounts } from "../_shared/platform.ts";
// MCP v2 surface (#18): no more direct mutation verbs — every content write
// goes through mem_stage_changes (op-codes → apply). The write.ts handlers
// are still called by OPS at apply time; mcp only uses the comment ones now.
import { addComment, resolveComment, updateDocument, deleteDocument } from "../_shared/write.ts";
import {
  createSection, renameSection, deleteSection, deleteSectionCascade, reorder, moveDocuments, splitSection, mergeSections,
  moveDocumentsCrossWorkspace, moveSectionCrossWorkspace,
} from "../_shared/restructure.ts";
import { listRevisions } from "../_shared/revisions.ts";
import { logUsage, listUsageLogs, USAGE_KINDS } from "../_shared/usage_log.ts";
import { withCallLog } from "../_shared/calllog.ts";
import {
  stageChanges, getIngestion, listIngestions, applyIngestion, rejectIngestion,
} from "../_shared/ingestion.ts";
import { blockType, sourceKind, linkRelation, commentTarget } from "../_shared/db.ts";

const BT = blockType.enumValues as [string, ...string[]];
const SK = sourceKind.enumValues as [string, ...string[]];
const LR = linkRelation.enumValues as [string, ...string[]];
const CT = commentTarget.enumValues as [string, ...string[]];

const INSTRUCTIONS = `Memento — structured, sourced, multi-KB knowledge base.

This preamble IS your global doctrine (how Memento works); each KB ALSO carries
its own doctrine — mem_doctrine(workspace).

STRUCTURE: an **org** = a tenant (member directory: team, mission, client —
each also has their personal org); a **KB** (workspace) = a body of knowledge belonging
to ONE org, which CARRIES ITS SCOPE: visibility "org" (all org members, their
default org role), "private" (explicit accesses only) or "public" (readable/searchable
by everyone, the org keeps curation), plus per-KB individual **grants** (promote a member
to curator, invite an external party — mem_grant; a grant gives read or write, NEVER
governance). Your effective role on a KB = max(grant, org role if visibility=org|public);
curator+ = write, member = read. Governance (share, visibility, archive,
transfer) = admin of the owning ORG only. myRole null = a KB of your org that is manageable
but not readable (private without a grant).

GETTING STARTED (important — the server is stateless):
1. Orient yourself with THIS preamble (above + below), then call mem_workspaces:
   your map = orgs (→ your role → KB) + "shared" (KB shared with you outside your orgs) +
   "pinned" (public KB from other orgs that you pinned) + your default KB ("default").
2. To FIND information, prefer mem_search(workspace:"*") — it searches across your WHOLE
   universe (orgs + shared + pinned) — rather than walking the tree by hand.
3. Want to follow a public KB from another org? mem_pin_workspace({workspace}): it
   joins "pinned" and the search scope. mem_unpin_workspace to remove it.
4. Ambiguous? Set the default KB: mem_use_workspace({workspace}) (persisted, ≠ pin).
   Verbs taking "workspace" may omit it → default KB; an explicit "workspace" takes precedence.
5. Responses echo "workspace" AND "org": CHECK them, and tell the user where you
   read/write (especially before a write). When in doubt, ask.
6. Creating: mem_create_workspace requires "org" (pick it from mem_workspaces; mem_orgs is
   only for member detail).

doctrine-first PROTOCOL: on a targeted KB, mem_doctrine (preamble + tree + conventions)
BEFORE any drill. Target 2-3 sections, then mem_section / mem_document / mem_block, or
mem_search (hybrid: exact words + paraphrases). To READ/answer, never load
the whole base (target). To WRITE, it's the opposite — see LOAD BEFORE WRITING.

search vs enumeration ROUTING: mem_search is top-k, NEVER exhaustive. For
"all / which ones / how many / what's new since" → mem_list / mem_count
(deterministic, 100 % recall) and mem_revisions({since}) for the session delta.

WRITING: reserved for the org's admin/curator roles. Never mutate blindly —
propose via mem_stage_changes (→ human review), then mem_apply_ingestion.
Contradictions are never auto-applied.

LOAD BEFORE WRITING: on a reasonably sized KB, call mem_load(workspace)
BEFORE proposing a mem_stage_changes — you get all the content (+ a loadToken to
pass back to mem_stage_changes). It saves you from duplicates, lets you place the block in the
right spot, and gives you the blockId values to link. Proposing without loading is flagged (loadGate
field in the response).

LINKS (graph): when the loaded content makes you see a logical relation between two
blocks — especially CONTRADICTS (two facts oppose each other), SUPERSEDES (one obsoletes the other),
DEPENDS_ON (one presupposes the other) — set the link (op link_blocks in your
mem_stage_changes): the IDs are already in front of you. Don't spam RELATED (search
already covers topic adjacency) — aim for what a future reader MUST see. Explore
the existing graph with mem_neighborhood before modifying a heavily linked block.

FEEDBACK (near-mandatory): whenever Memento surprises you — unexpected error,
a search that misses content that should exist, a missing verb/capability,
an ambiguous parameter, a misleading description — report it via mem_log_usage BEFORE
working around it. One line is enough; it writes nothing to the KB and never blocks
your work. This is how the tool improves.`;

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const idOrPath = { id: z.string().optional(), path: z.string().optional() };

// Anti-DoS bounds on write inputs (content size + batch cardinality):
// the Edge isolate has limited memory and the KB can store bulky content.
// The MCP SDK rejects oversized input early (before any I/O).
const MAX_CONTENT = 200_000; // a block's content / a document's markdown
const MAX_TEXT = 20_000;     // short text fields (the preamble aside: long)
const MAX_BATCH = 500;       // items in an array of ids / of changes
const longStr = z.string().max(MAX_CONTENT);
const textStr = z.string().max(MAX_TEXT);

/** Wraps a handler: translates an access denial into a readable error result.
 *  `args` is typed `any`: the SDK already validates the shape at runtime via the Zod inputSchema. */
function guarded(fn: (args: any) => Promise<any>) {
  return async (args: any) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof AccessError) {
        return { content: [{ type: "text" as const, text: `Access denied: ${e.message}` }], isError: true };
      }
      if (e instanceof RateLimitError) {
        return { content: [{ type: "text" as const, text: e.message }], isError: true };
      }
      // We never propagate the raw error (DB schema / external system leak):
      // detail logged server-side, safe message returned to the agent.
      console.error("[mcp] verb failed:", e);
      return { content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(e)}` }], isError: true };
    }
  };
}

/** Builds a fresh MCP server (one per request in stateless mode), scoped to user `sub`. */
function buildServer(sub: string): McpServer {
  const server = new McpServer({
    name: "memento",
    title: "Memento",
    version: "0.1.0",
    websiteUrl: "https://me.mento.cc",
    // claude.ai lit l'icône du connecteur dans serverInfo.icons (handshake
    // initialize), PAS le favicon.ico du domaine. Sans ça → glyphe générique (livre).
    icons: [
      { src: "https://me.mento.cc/favicon.svg", mimeType: "image/svg+xml" },
      { src: "https://me.mento.cc/android-chrome-512x512.png", mimeType: "image/png", sizes: ["512x512"] },
    ],
  }, { instructions: INSTRUCTIONS });

  // Call log (otomata-calllog, tool_calls table): registerTool is
  // intercepted ONCE — every verb goes through withCallLog without touching
  // the ~50 declarations.
  const register = server.registerTool.bind(server);
  // deno-lint-ignore no-explicit-any
  server.registerTool = ((name: string, cfg: any, handler: any) =>
    register(name, cfg, withCallLog(name, sub, handler))) as typeof server.registerTool;

  server.registerTool("mem_workspaces", {
    description:
      "YOUR CONTEXT MAP — the starting point. Full topology: your orgs (tenants, including your personal org `personal:true`) → their visible KB with YOUR effective role and `visibility` (org|private|public), " +
      "+ `shared` (KB shared with you outside your orgs), + `pinned` (public KB from other orgs that you pinned — mem_pin_workspace), + your default KB (`default`). " +
      "Use it to pick the target; change the default with mem_use_workspace. To FIND information rather than browse: mem_search(workspace:\"*\").",
    inputSchema: {},
  }, guarded(async () => json(await contextMap(sub))));

  server.registerTool("mem_use_workspace", {
    description:
      "Sets your default KB (persisted). Verbs that accept `workspace` will use it when you omit it. " +
      "An explicit `workspace` always takes precedence. Call it at the start of a session to frame the context.",
    inputSchema: { workspace: z.string().describe("KB slug, e.g. demo") },
  }, guarded(async ({ workspace }) => {
    // Check access BEFORE setting the default: we don't confirm the existence
    // of a KB from another tenant and we don't echo its org.
    await assertAccess(sub, { workspace });
    const w = await setDefaultWorkspace(sub, workspace);
    const { org } = await wsContext(sub, w.slug);
    return json({ default: w.slug, name: w.name, org, message: `Default KB: ${w.name} (${w.slug}, org ${org})` });
  }));

  server.registerTool("mem_pin_workspace", {
    description:
      "Pins a KB in your universe (typically a public KB from another org): it appears in mem_workspaces' `pinned` " +
      "and enters the scope of mem_search(workspace:\"*\"). Distinct from the default KB (mem_use_workspace). Idempotent.",
    inputSchema: { workspace: z.string().describe("slug of the KB to pin") },
  }, guarded(async ({ workspace }) => {
    await assertAccess(sub, { workspace }); // readable (public KB are readable by everyone)
    const w = await pinWorkspace(sub, workspace);
    return json({ pinned: w.slug, name: w.name, message: `KB pinned: ${w.name} (${w.slug})` });
  }));

  server.registerTool("mem_unpin_workspace", {
    description: "Removes a KB from your pinned ones (takes it out of `pinned` and the global search scope).",
    inputSchema: { workspace: z.string().describe("slug of the KB to unpin") },
  }, guarded(async ({ workspace }) => {
    return json({ unpinned: (await unpinWorkspace(sub, workspace)).slug });
  }));

  server.registerTool("mem_set_doctrine", {
    description:
      "Writes a KB's doctrine preamble (meta-instructions, markdown) — the compass read by mem_doctrine. " +
      "Set it on a new KB (otherwise its map is empty). Admin/curator only. `workspace` optional = default KB.",
    inputSchema: { workspace: z.string().optional(), preamble: longStr },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws }, { write: true });
    return json({ workspace: ws, org, ...(await setDoctrine({ workspace: ws, preamble: args.preamble }, sub)) });
  }));

  server.registerTool("mem_update_workspace", {
    description: "Edits a KB's metadata (name and/or summary). The slug stays stable. Admin/curator only.",
    inputSchema: { workspace: z.string().optional(), name: z.string().optional(), summary: z.string().optional() },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws }, { write: true });
    return json({ workspace: ws, org, ...(await updateWorkspace({ workspace: ws, name: args.name, summary: args.summary }, sub)) });
  }));

  server.registerTool("mem_archive_workspace", {
    description: "Archives (hides) a KB, or reactivates it (`archived:false`). Reversible. Reserved for admins of the owning org.",
    inputSchema: { workspace: z.string().optional(), archived: z.boolean().optional() },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertWorkspaceAdmin(sub, ws);
    return json({ workspace: ws, org, ...(await archiveWorkspace({ workspace: ws, archived: args.archived }, sub)) });
  }));

  server.registerTool("mem_delete_workspace", {
    description: "HARD-deletes a whole KB and ALL its content (documents, blocks, sections, revisions, ingestions — irreversible). The KB must be ARCHIVED first (mem_archive_workspace): archive = reversible step 1, delete = irreversible step 2. Org-admin only. `workspace` is required (no default, to avoid deleting the wrong KB).",
    inputSchema: { workspace: z.string() },
  }, guarded(async (args) => json(await deleteWorkspace(sub, { workspace: args.workspace }))));

  server.registerTool("mem_grants", {
    description:
      "A KB's \"who has access\": visibility (org|private), individual grants (email, role, pending) " +
      "AND accesses inherited from the org (`inherited`, if visibility=org). Reserved for admins of the owning org.",
    inputSchema: { workspace: z.string().optional().describe("KB slug; omitted = default KB") },
  }, guarded(async (args) => {
    const { workspace: ws } = await wsContext(sub, args.workspace);
    return json(await listGrants(sub, { workspace: ws }));
  }));

  server.registerTool("mem_grant", {
    description:
      "Grants (or updates) a person's access to ONE KB, by email — including someone EXTERNAL to the org (guest): " +
      "nonexistent account → provisioned + invitation email. Role: member (read) | curator (write) — " +
      "never governance (share/transfer stay with the org-admin). Reserved for admins of the owning org. " +
      "To add someone to ALL of an org's KB → org invitation (mem_orgs).",
    inputSchema: {
      workspace: z.string().optional().describe("KB slug; omitted = default KB"),
      email: z.string().describe("the person's email"),
      role: z.enum(["curator", "member"]).optional().describe("default member (read)"),
    },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    return json({ org, ...(await grantAccess(sub, { workspace: ws, email: args.email, role: args.role })) });
  }));

  server.registerTool("mem_revoke_grant", {
    description:
      "Removes an explicit access to a KB (by userId, cf. mem_grants). Reserved for admins of the owning org.",
    inputSchema: {
      workspace: z.string().optional().describe("KB slug; omitted = default KB"),
      userId: z.string().describe("the user's sub (cf. mem_grants)"),
    },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    return json({ org, ...(await revokeGrant(sub, { workspace: ws, userId: args.userId })) });
  }));

  server.registerTool("mem_set_visibility", {
    description:
      "Changes a KB's scope: `org` (all org members, default org role), `private` " +
      "(explicit grants only — a curator grant is set for you along the way so you keep reading it), " +
      "or `public` (readable and searchable by EVERYONE, anonymous included: public gallery + mem_public_search; " +
      "your org keeps write). Reserved for admins of the owning org.",
    inputSchema: {
      workspace: z.string().optional().describe("KB slug; omitted = default KB"),
      visibility: z.enum(["org", "private", "public"]),
    },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    return json({ org, ...(await setVisibility(sub, { workspace: ws, visibility: args.visibility })) });
  }));

  server.registerTool("mem_orgs", {
    description:
      "Detail of your organizations: MEMBERS (email, role, pending) in addition to the KB. " +
      "To simply pick a target org/KB, mem_workspaces is enough (lightweight topology).",
    inputSchema: {},
  }, guarded(async () => json(await listMyOrgs(sub))));

  server.registerTool("mem_accounts", {
    description:
      "PLATFORM VIEW (reserved for MEMENTO_PLATFORM_ADMINS operators): all auth accounts — " +
      "email, creation date, last login, provider, org memberships (null = account with no org, " +
      "signup is open). For the members of a specific org, mem_orgs is enough.",
    inputSchema: {},
  }, guarded(async () => json(await listAccounts(sub))));

  server.registerTool("mem_create_org", {
    description:
      "Creates an organization = a sharing scope (mission/client, personal); you become its admin. " +
      "Chain with mem_create_workspace({org}) to create KB in it. Slug derived from the name unless provided.",
    inputSchema: {
      name: z.string().describe("human-readable name, e.g. Demo KB"),
      slug: z.string().optional().describe("desired slug; default = derived from the name"),
    },
  }, guarded(async (args) => json(await createOrg(sub, args))));

  server.registerTool("mem_update_org", {
    description:
      "Renames an org you administer: change its display `name` and/or its `slug` " +
      "(the stable handle used by orgSlug-addressed verbs). Slug must stay globally unique — " +
      "a collision errors (no silent suffixing). A personal org's slug is locked.",
    inputSchema: {
      org: z.string().describe("slug of the org to rename"),
      name: z.string().optional().describe("new display name"),
      slug: z.string().optional().describe("new slug (globally unique)"),
    },
  }, guarded(async (args) => json(await updateOrg(sub, { orgSlug: args.org, name: args.name, slug: args.slug }))));

  server.registerTool("mem_create_workspace", {
    description:
      "Creates an empty KB (workspace) attached to an org you're an admin of (your personal org always works). " +
      "`visibility`: org (default, all org members), private (you only, then mem_grant), " +
      "or public (readable/searchable by everyone — better to switch afterward via mem_set_visibility). " +
      "The slug is derived from the name (unique across all orgs) unless provided. " +
      "Chain with mem_set_doctrine to set the compass, otherwise the map is empty.",
    inputSchema: {
      org: z.string().describe("slug of the owning org, e.g. otomata"),
      name: z.string().describe("human-readable name of the KB"),
      summary: z.string().optional().describe("short summary (the KB's purpose)"),
      slug: z.string().optional().describe("desired slug; default = derived from the name"),
      visibility: z.enum(["org", "private", "public"]).optional().describe("default org"),
    },
  }, guarded(async (args) =>
    json(await createWorkspace(sub, {
      orgSlug: args.org, name: args.name, summary: args.summary, slug: args.slug, visibility: args.visibility,
    })),
  ));

  server.registerTool("mem_transfer_workspace", {
    description:
      "Transfers a KB to another org = changes TENANT (e.g. promote a KB from your personal org to " +
      "the team org). The scope (visibility/grants) follows the KB; the content does not move. To adjust " +
      "WHO sees the KB without changing org → mem_grant/mem_set_visibility. " +
      "Reserved for admins of BOTH orgs (source and destination).",
    inputSchema: {
      workspace: z.string().describe("slug of the KB to transfer"),
      toOrg: z.string().describe("slug of the destination org"),
    },
  }, guarded(async (args) => json(await transferWorkspace(sub, args))));

  server.registerTool("mem_doctrine", {
    description:
      "doctrine-first ENTRY POINT. Compact map of a KB: preamble (meta-instructions), section tree (titles + summaries + counters, WITHOUT content) and conventions. Call it first to target 2-3 sections before any drill. `workspace` optional: defaults to your current KB (cf. mem_use_workspace).",
    inputSchema: { workspace: z.string().optional().describe("KB slug; omitted = default KB") },
  }, guarded(async ({ workspace }) => {
    const { workspace: ws, org } = await wsContext(sub, workspace);
    await assertAccess(sub, { workspace: ws });
    return json({ workspace: ws, org, ...(await getDoctrine(ws)) });
  }));

  server.registerTool("mem_load", {
    description:
      "Loads a KB IN FULL (all documents + the content of all blocks, ordered) — call it BEFORE proposing a write (mem_stage_changes) in a reasonably sized KB. " +
      "Gives you the full context to: avoid duplicates, place your block in the right spot, and spot the typed links to set (CONTRADICTS/SUPERSEDES/DEPENDS_ON). " +
      "Returns a `loadToken` to pass back to mem_stage_changes (proves you loaded the current version). " +
      "If the KB exceeds the size threshold (`loaded: false`), the full load is not rendered: target instead via mem_doctrine + mem_search/mem_list. `workspace` omitted = default KB.",
    inputSchema: { workspace: z.string().optional().describe("KB slug; omitted = default KB") },
  }, guarded(async ({ workspace }) => {
    const { workspace: ws, org } = await wsContext(sub, workspace);
    await assertAccess(sub, { workspace: ws });
    const wsId = await resolveWorkspaceId({ workspace: ws });
    return json({ workspace: ws, org, ...(await loadWorkspace(wsId!)) });
  }));

  server.registerTool("mem_section", {
    description:
      "Unfolds a zone of the tree: sub-sections + documents (title, summary, status, counters). Does NOT render blocks. By `id` or `path`.",
    inputSchema: idOrPath,
  }, guarded(async (args) => {
    await assertAccess(sub, args.path ? { path: args.path } : { id: args.id, kind: "section" });
    return json(await getSection(args));
  }));

  server.registerTool("mem_document", {
    description:
      "Renders a document: ordered blocks (id, type, content) + sources, links and comments per block. By `id` or `path`. " +
      "`document.url` = THE viewer link to give the human (specific block: append `?block=<id>`) — never craft a URL yourself.",
    inputSchema: idOrPath,
  }, guarded(async (args) => {
    await assertAccess(sub, args.path ? { path: args.path } : { id: args.id, kind: "document" });
    return json(await getDocument(args));
  }));

  server.registerTool("mem_block", {
    description:
      "Renders an isolated block with its sources, links (incoming + outgoing) and comments. To inspect a search hit. " +
      "`url` = THE viewer link to give the human — never craft a URL yourself.",
    inputSchema: { id: z.string() },
  }, guarded(async ({ id }) => {
    await assertAccess(sub, { id, kind: "block" });
    return json(await getBlock(id));
  }));

  server.registerTool("mem_neighborhood", {
    description:
      "Traverses the link graph around a block: subgraph (nodes = blocks with excerpt + document/section, edges = typed links) up to `depth` hops (1-3, default 1). " +
      "Filters: `relations` (REFERENCES|DEPENDS_ON|CONTRADICTS|SUPERSEDES|RELATED), `direction` out|in|both (default both). " +
      "Uses: see what depends on a principle before modifying it, follow a chain of contradictions, explore the neighborhood of a hit. Drill in afterward with mem_block.",
    inputSchema: {
      blockId: z.string(),
      depth: z.number().int().min(1).max(3).optional(),
      relations: z.array(z.enum(LR)).optional(),
      direction: z.enum(["out", "in", "both"]).optional(),
    },
  }, guarded(async (args) => {
    // A link never crosses two workspaces (invariant §4): access to the root
    // block covers the whole subgraph.
    await assertAccess(sub, { id: args.blockId, kind: "block" });
    return json(await neighborhood(args));
  }));

  server.registerTool("mem_search", {
    description:
      "THE search — hybrid by default: French full-text (exact words) + semantic (paraphrases, kNN embeddings), RRF fusion. Each hit: blockId, matchedBy, snippet/excerpt, doc, `url` (THE viewer link to give the human — never craft a URL), {workspace, org} + judgment metadata (docStatus, verifiedAt, updatedAt, sourceCount, superseded/contradicted). " +
      "Blocks of DEPRECATED documents are demoted (not excluded) — `includeDeprecated` for a pure ranking. `lexicalTotal` = true number of matches, `hasMore` indicates whether to broaden. CAUTION: top-k, never exhaustive — for \"all / how many / since\" → mem_list/mem_count. " +
      "`workspace` omitted = default KB; `\"*\"` = your WHOLE universe — your orgs + shared KB + pinned public KB (\"where did I note that?\" — `sectionPath` is refused there). `likeBlockId` (instead of `q`) = blocks close to an anchor block (dedup, link suggestions, ingestion targeting). " +
      "`mode` lexical|semantic to force a single regime (rarely useful). If embedding is unavailable, degrades to lexical and flags it (`modes`). Drill in afterward with mem_block.",
    inputSchema: {
      q: z.string().optional().describe("text query (keywords or phrase — both regimes feed on it)"),
      likeBlockId: z.string().optional().describe("anchor block: returns the semantically close blocks (excludes q)"),
      workspace: z.string().optional().describe('KB slug; omitted = default KB; "*" = all your KB'),
      mode: z.enum(["hybrid", "lexical", "semantic"]).optional(),
      blockType: z.string().optional(),
      sectionPath: z.string().optional(),
      docKind: z.string().optional(),
      includeDeprecated: z.boolean().optional().describe("true = don't demote blocks of DEPRECATED documents"),
      maxHits: z.number().int().min(1).max(100).optional(),
    },
  }, guarded(async (args) => {
    // Anchor-block mode: pure semantic, scoped to the block's KB — same filters
    // as search (no filter accepted-then-ignored).
    if (args.likeBlockId) {
      await assertAccess(sub, { id: args.likeBlockId, kind: "block" });
      const wsId = await resolveWorkspaceId({ id: args.likeBlockId, kind: "block" });
      const ws = await resolveWorkspaceById(wsId!);
      const sectionIds = args.sectionPath
        ? await resolveSectionIds(ws.id, ws.slug, args.sectionPath)
        : null;
      const similar = await similarBlocks({
        workspaceIds: [ws.id],
        blockId: args.likeBlockId,
        k: args.maxHits,
        blockType: args.blockType,
        docKind: args.docKind,
        sectionIds,
      });
      return json({
        ...similar,
        hits: similar.hits.map((h) => ({ ...h, url: docUrl(ws.slug, h.document.id, h.blockId) })),
      });
    }
    if (!args.q?.trim()) throw new Error("`q` or `likeBlockId` required");

    // Target: one KB (explicit/default) or all ("*").
    let targets: { id: string; slug: string; org: string }[];
    let scope: Record<string, unknown>;
    if (args.workspace === "*") {
      await assertWithinLimit(sub, "search_global"); // costly fan-out (full-text + kNN over N KB)
      targets = await accessibleWorkspaceRefs(sub);
      scope = { scope: "all" };
    } else {
      const { workspace: ws, org } = await wsContext(sub, args.workspace);
      await assertAccess(sub, { workspace: ws });
      const { id } = await resolveWorkspaceBySlug(ws);
      targets = [{ id, slug: ws, org }];
      scope = { workspace: ws, org };
    }
    return json({ ...scope, ...(await hybridSearch({ workspaces: targets, ...args, q: args.q })) });
  }));

  server.registerTool("mem_public_search", {
    description:
      "PUBLIC SEARCH — full-text over ALL of Memento's public KB (not just yours), " +
      "with no membership required. To discover knowledge openly shared by other orgs. " +
      "Each hit is labeled {workspace, org} + viewer `url`; then pin a found KB via " +
      "mem_use_workspace, or read it by slug (mem_doctrine/mem_document). Lexical only (deterministic).",
    inputSchema: {
      q: z.string().describe("text query (keywords or phrase)"),
      blockType: z.string().optional(),
      docKind: z.string().optional(),
      maxHits: z.number().int().min(1).max(100).optional(),
    },
  }, guarded(async (args) => {
    if (!args.q?.trim()) throw new Error("`q` required");
    await assertWithinLimit(sub, "search_public");
    return json({ scope: "public", ...(await searchPublic(args)) });
  }));

  server.registerTool("mem_list", {
    description:
      "DETERMINISTIC enumeration — 100 % recall, the complement to mem_search (top-k). For \"list everything\", \"which ones\", \"what changed since\" → mem_list; for \"how many\" → mem_count. NEVER mem_search for exhaustive needs. " +
      "`kind` blocks (default) | documents. Compact rows (id, type, excerpt 100c, docPath, statuses, dates, counters) + `totalCount` (true number of matches), `hasMore`, `cursor` (keyset — pass it back as-is for the next page). Sort: updated_at descending (most recent first). " +
      "Combinable filters: blockType, docStatus, verified, hasSource, sectionPath, docKind, updatedSince/updatedUntil. E.g. \"all unverified REGLE\" = {blockType:\"REGLE\", verified:false}. Drill in afterward with mem_block/mem_document.",
    inputSchema: {
      workspace: z.string().optional().describe("KB slug; omitted = default KB"),
      kind: z.enum(["blocks", "documents"]).optional(),
      blockType: z.string().optional(),
      docStatus: z.enum(["ACTIVE", "DEPRECATED"]).optional(),
      verified: z.boolean().optional().describe("true = verified only, false = unverified only"),
      hasSource: z.boolean().optional(),
      sectionPath: z.string().optional(),
      docKind: z.string().optional(),
      updatedSince: z.string().optional().describe("ISO 8601 — e.g. 2026-06-08T00:00:00Z"),
      updatedUntil: z.string().optional(),
      cursor: z.string().optional().describe("opaque cursor returned by the previous page"),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, guarded(async (args) => {
    const { workspace: _w, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws });
    return json({ workspace: ws, org, ...(await listItems({ ...rest, workspace: ws })) });
  }));

  server.registerTool("mem_count", {
    description:
      "Counts/aggregates WITHOUT enumerating — same filters as mem_list, pure SQL, exact by construction. For \"how many blocks without a source\", \"breakdown by type/section\" → this verb, never mem_search. " +
      "`groupBy` type|docStatus|section|docKind → breakdown sorted by count (section = slugified path).",
    inputSchema: {
      workspace: z.string().optional().describe("KB slug; omitted = default KB"),
      kind: z.enum(["blocks", "documents"]).optional(),
      groupBy: z.enum(["type", "docStatus", "section", "docKind"]).optional(),
      blockType: z.string().optional(),
      docStatus: z.enum(["ACTIVE", "DEPRECATED"]).optional(),
      verified: z.boolean().optional(),
      hasSource: z.boolean().optional(),
      sectionPath: z.string().optional(),
      docKind: z.string().optional(),
      updatedSince: z.string().optional(),
      updatedUntil: z.string().optional(),
    },
  }, guarded(async (args) => {
    const { workspace: _w, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws });
    return json({ workspace: ws, org, ...(await countItems({ ...rest, workspace: ws })) });
  }));

  // ── Comments (review) ───────────────────────────────────────────────────────
  server.registerTool("mem_comment", {
    description:
      "Annotates a block/document/section. targetType ∈ BLOCK|DOCUMENT|SECTION. `authorKind` human|agent (default human).",
    inputSchema: {
      targetType: z.enum(CT), targetId: z.string(), body: z.string(),
      authorKind: z.string().optional(),
    },
  }, guarded(async (args) => {
    const kind = args.targetType.toLowerCase() as "block" | "document" | "section";
    await assertAccess(sub, { id: args.targetId, kind }, { write: true });
    return json(await addComment(args, sub));
  }));

  server.registerTool("mem_resolve_comment", {
    description: "Marks a comment as resolved (timestamp).",
    inputSchema: { id: z.string() },
  }, guarded(async ({ id }) => {
    await assertAccess(sub, { id, kind: "comment" }, { write: true });
    return json(await resolveComment({ id }));
  }));

  // ── Restructuring (Batch 4) — composite, atomic, dry_run ────────────────────
  server.registerTool("mem_create_section", {
    description: "Creates a section (root if no `parentId`). Tree depth ≤ 3. `workspace` optional = default KB.",
    inputSchema: {
      workspace: z.string().optional(), parentId: z.string().optional(),
      title: z.string(), summary: z.string().optional(), position: z.number().int().optional(),
    },
  }, guarded(async (args) => {
    const { workspace: _w, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws }, { write: true });
    return json({ workspace: ws, org, ...(await createSection({ ...rest, workspace: ws }, sub)) });
  }));

  server.registerTool("mem_rename_section", {
    description: "Renames a section (title and/or summary). By default the slug stays stable (paths don't break); pass `slug` to deliberately re-slug it (slugified + deduped — CHANGES the path).",
    inputSchema: { id: z.string(), title: z.string().optional(), summary: z.string().optional(), slug: z.string().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "section" }, { write: true });
    return json(await renameSection(args, sub));
  }));

  server.registerTool("mem_delete_section", {
    description: "Deletes an EMPTY section (no documents, no sub-sections). Otherwise, move/merge first.",
    inputSchema: { id: z.string(), reason: z.string().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "section" }, { write: true });
    return json(await deleteSection(args, sub));
  }));

  server.registerTool("mem_reorder", {
    description: "Reorders a parent's children: `orderedChildIds` = all sections (same parent) OR all documents (same section).",
    inputSchema: { parentId: z.string().optional(), orderedChildIds: z.array(z.string()).max(MAX_BATCH) },
  }, guarded(async (args) => {
    // Authorization is done INSIDE reorder, tied to the real entities (resolved sections/docs),
    // not to a caller-supplied anchor — otherwise cross-workspace bypass (cf. security review).
    return json(await reorder(args, sub));
  }));

  server.registerTool("mem_move_documents", {
    description: "Moves documents to a target section (slug dedup). `dryRun:true` to preview without mutating.",
    inputSchema: { documentIds: z.array(z.string()).max(MAX_BATCH), targetSectionId: z.string(), dryRun: z.boolean().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.targetSectionId, kind: "section" }, { write: true });
    return json(await moveDocuments(args, sub));
  }));

  server.registerTool("mem_split_section", {
    description: "Splits a section: creates a new sibling section and moves `documentIdsToMove` into it. `dryRun:true` to preview.",
    inputSchema: { id: z.string(), newSectionTitle: z.string(), documentIdsToMove: z.array(z.string()).max(MAX_BATCH), dryRun: z.boolean().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "section" }, { write: true });
    return json(await splitSection(args, sub));
  }));

  server.registerTool("mem_merge_sections", {
    description: "Merges sections (without sub-sections) into a target: moves their documents then deletes the source sections. `dryRun:true` to preview.",
    inputSchema: { sourceIds: z.array(z.string()).max(MAX_BATCH), targetId: z.string(), dryRun: z.boolean().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.targetId, kind: "section" }, { write: true });
    return json(await mergeSections(args, sub));
  }));

  server.registerTool("mem_move_documents_cross", {
    description: "Moves documents to a target section that MAY be in another KB/org (cross-workspace). Logs a revision on both sides. `dryRun:true` to preview. For same-KB moves, prefer mem_move_documents.",
    inputSchema: { documentIds: z.array(z.string()).max(MAX_BATCH), targetSectionId: z.string(), dryRun: z.boolean().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.targetSectionId, kind: "section" }, { write: true });
    for (const id of args.documentIds) await assertAccess(sub, { id, kind: "document" }, { write: true });
    return json(await moveDocumentsCrossWorkspace(args, sub));
  }));

  server.registerTool("mem_move_section_cross", {
    description: "Moves a section subtree to another KB/org (cross-workspace), optionally under `targetParentId` (else a root section of the target KB). `dryRun:true` to preview.",
    inputSchema: { sectionId: z.string(), targetWorkspace: z.string(), targetParentId: z.string().optional(), dryRun: z.boolean().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.sectionId, kind: "section" }, { write: true });
    await assertAccess(sub, { workspace: args.targetWorkspace }, { write: true });
    return json(await moveSectionCrossWorkspace(args, sub));
  }));

  server.registerTool("mem_update_document", {
    description: "Edits a document's `title` and/or `summary` (its metadata, NOT its blocks — for content use update_block). The slug stays stable so deep-links don't break. Use it to keep a doc's one-line summary in sync after its blocks have moved/changed.",
    inputSchema: { id: z.string(), title: z.string().optional(), summary: z.string().optional(), reason: z.string().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "document" }, { write: true });
    return json(await updateDocument(args, sub));
  }));

  server.registerTool("mem_delete_document", {
    description: "HARD-deletes a document and all its blocks (irreversible — blocks, sources links and comments are purged). For reversible obsolescence, prefer deprecate_document.",
    inputSchema: { id: z.string(), reason: z.string().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "document" }, { write: true });
    return json(await deleteDocument(args, sub));
  }));

  server.registerTool("mem_delete_section_cascade", {
    description: "HARD-deletes a section AND its whole subtree (sub-sections + documents). Irreversible. For an empty section, prefer mem_delete_section.",
    inputSchema: { id: z.string(), reason: z.string().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "section" }, { write: true });
    return json(await deleteSectionCascade(args, sub));
  }));

  server.registerTool("mem_revisions", {
    description:
      "Log of a workspace's curated mutations (op, reason, actor, before/after), from most recent to oldest. Filters: `targetType` (block|document|section), `targetId`, `since` (\"what changed since my last session?\"), `limit`. `total`/`hasMore` = true count of matches.",
    inputSchema: {
      workspace: z.string().optional(),
      targetType: z.string().optional(),
      targetId: z.string().optional(),
      since: z.string().optional().describe("ISO 8601 — returns only later revisions"),
      limit: z.number().int().positive().optional(),
    },
  }, guarded(async (args) => {
    const { workspace: _w, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws });
    return json({ workspace: ws, org, ...(await listRevisions({ ...rest, workspace: ws })) });
  }));

  // ── propose-validate loop (Batch 5) ─────────────────────────────────────────
  server.registerTool("mem_stage_changes", {
    description:
      "Proposes a change-set (mutates NOTHING) → creates a PROPOSED MemIngestion, reviewed by a human before application. " +
      "The response echoes `url` = THE review link (Loop) to give the human — never craft a URL yourself. " +
      "`changes[]` = [{op, payload, class?, target?, rationale?}]. " +
      "op ∈ add_document|add_block|update_block|set_block_type|delete_block|attach_source|detach_source|verify_block|move_block|link_blocks|deprecate_document. " +
      "`payload` = the arguments of the corresponding verb. class ∈ CONFIRM|ENRICH|CONTRADICT|OBSOLETE (CONTRADICT is never auto-applied). " +
      "`clientKey` (recommended) = idempotency AND revision key: if an open ingestion (PROPOSED/PARTIAL/CHANGES_REQUESTED) " +
      "already carries this clientKey, your new call REPLACES its change-set and reopens it as PROPOSED (`superseded: true`) — this is how you respond to a sent-back ingestion: " +
      "re-read the feedback via mem_ingestion_get, then re-stage with the SAME clientKey. A closed ingestion (APPLIED/REJECTED) stays a no-op (`deduplicated: true`). " +
      "The response flags near-identical blocks already in the base for each proposed add_block (`similarExisting`) — prefer CONFIRM/verify on the existing one over a duplicate.",
    inputSchema: {
      workspace: z.string().optional(),
      title: z.string(),
      summary: z.string().optional(),
      sourceId: z.string().optional(),
      clientKey: z.string().optional().describe("idempotency key (unique per workspace) — provide it for safe retries"),
      loadToken: z.string().optional().describe("token returned by mem_load — proves you loaded the KB before writing"),
      changes: z.array(z.object({
        op: z.string(),
        payload: z.record(z.string(), z.any()).optional(),
        class: z.enum(["CONFIRM", "ENRICH", "CONTRADICT", "OBSOLETE"]).optional(),
        target: z.string().optional(),
        rationale: z.string().optional(),
      })).max(MAX_BATCH),
    },
  }, guarded(async (args) => {
    const { workspace: _w, loadToken, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws }, { write: true });
    const wsId = await resolveWorkspaceId({ workspace: ws });
    const gate = await loadGate(sub, wsId!, "mem_stage_changes", loadToken);
    const staged = await stageChanges({ ...rest, workspace: ws }, sub);
    return json({ workspace: ws, org, ...staged, ...(gate.warning ? { loadGate: gate.warning } : {}) });
  }));

  server.registerTool("mem_ingestion_list", {
    description: "Lists a KB's ingestions (counts by class + state). Filter `status` (PROPOSED|APPLIED|REJECTED|PARTIAL|CHANGES_REQUESTED). " +
      "status=CHANGES_REQUESTED → the ingestions a human sent back to you for revision: re-read them (mem_ingestion_get), handle the feedback, re-stage with the same clientKey. `workspace` optional = default KB.",
    inputSchema: { workspace: z.string().optional(), status: z.string().optional() },
  }, guarded(async (args) => {
    const { workspace: _w, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws });
    return json({ workspace: ws, org, ...(await listIngestions({ ...rest, workspace: ws })) });
  }));

  server.registerTool("mem_ingestion_get", {
    description: "Review of an ingestion: the diff classified op by op, with the state (applied/error) of each. " +
      "If it was sent back to you (status CHANGES_REQUESTED), read `reviewNote` (global note) and `changes[].feedback[]` (per-change feedback): that's what to fix before re-staging with the same clientKey.",
    inputSchema: { id: z.string() },
  }, guarded(async ({ id }) => {
    await assertAccess(sub, { id, kind: "ingestion" });
    return json(await getIngestion(id));
  }));

  server.registerTool("mem_apply_ingestion", {
    description:
      "Applies a PROPOSED/PARTIAL ingestion, transactionally per op (one MemRevision per op, linked to the ingestion). " +
      "Without `acceptIds`, applies everything EXCEPT the CONTRADICT ops (held pending). With `acceptIds`, applies only that subset (→ APPLIED if everything passes, otherwise PARTIAL).",
    inputSchema: { id: z.string(), acceptIds: z.array(z.string()).optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "ingestion" }, { write: true });
    return json(await applyIngestion(args, sub));
  }));

  server.registerTool("mem_reject_ingestion", {
    description: "Rejects an ingestion (→ REJECTED). `reason` recommended.",
    inputSchema: { id: z.string(), reason: z.string().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "ingestion" }, { write: true });
    return json(await rejectIngestion(args, sub));
  }));

  // ── Usage log (product feedback) — open to ANY authenticated user ───────────
  server.registerTool("mem_log_usage", {
    description:
      "NEAR-MANDATORY — report a problem encountered with Memento itself, as soon as it happens: " +
      "unexpected error, a search that misses content that should exist, a missing verb/capability, " +
      "an ambiguous parameter, a misleading description/doc, workflow friction. " +
      "kind ∈ bug (error/broken behavior) | unexpected (surprising result) | missing (absent capability) | " +
      "friction (doable but painful) | docs (misleading description) | other. " +
      "One line is enough (`summary`); put the useful context in `detail` (call args, error message, expected vs obtained). " +
      "Writes NOTHING to the KB, requires no role, never fails on context — log it then continue your work.",
    inputSchema: {
      kind: z.enum(USAGE_KINDS),
      summary: textStr.describe("the problem in one sentence"),
      detail: textStr.optional().describe("context: call args, exact error, expected vs obtained"),
      verb: z.string().optional().describe("the mem_* verb concerned, e.g. mem_search"),
      workspace: z.string().optional().describe("slug of the KB concerned if relevant (free text, never blocking)"),
    },
  }, guarded(async (args) => json(await logUsage(args, sub))));

  server.registerTool("mem_usage_logs", {
    description:
      "Reads the usage log (mem_log_usage reports), from most recent to oldest. " +
      "Without `workspace`: your own reports. With `workspace`: all of the KB's (admin/curator only). " +
      "Filters: `verb`, `kind`. To sift through the feedback and prioritize tool improvements.",
    inputSchema: {
      workspace: z.string().optional(),
      verb: z.string().optional(),
      kind: z.enum(USAGE_KINDS).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, guarded(async (args) => json(await listUsageLogs(args, sub))));

  return server;
}

// Federated catalog (service-to-service): the LIST of memento tools — a
// product-level manifest, identical for everyone — served to a trusted peer (oto) via a
// shared secret, WITHOUT user OAuth. Lets oto mount its federated tools at
// boot without depending on a revocable personal OAuth token (otomata#16). We extract
// the manifest via an in-memory transport: it's exactly the SDK's `tools/list`
// output (zod → JSON Schema conversion included), with no user context (empty sub: we
// only list the schemas, no handler is invoked).
async function federationCatalog(): Promise<Response> {
  // DYNAMIC imports: they isolate this path from module loading — if the SDK
  // resolved these specifiers badly, only /federation/catalog would fail, never the
  // main MCP server (the 52 tools stay served).
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer("");
  const client = new Client({ name: "federation-catalog", version: "1.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    const { tools } = await client.listTools();
    return new Response(JSON.stringify({ tools }), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    await client.close();
    await server.close();
  }
}

Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000) }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/health")) return new Response("ok");

  // OAuth discovery, served WITHOUT auth (RFC 9728 / 8414).
  const disc = isDiscoveryPath(url.pathname);
  if (disc === "prm") {
    return new Response(JSON.stringify(protectedResourceMetadata()), {
      headers: { "content-type": "application/json" },
    });
  }
  if (disc === "as") return authServerMetadata();

  // Federated catalog: authenticated by the SERVICE SECRET shared with oto
  // (MEMENTO_FEDERATION_SECRET), not by user OAuth. Before authenticate().
  if (url.pathname.endsWith("/federation/catalog")) {
    const secret = Deno.env.get("MEMENTO_FEDERATION_SECRET");
    const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!secret || !got || got !== secret) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }
    return await federationCatalog();
  }

  const auth = await authenticate(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.message }), {
      status: auth.status,
      headers: { "content-type": "application/json", "www-authenticate": wwwAuthenticate() },
    });
  }

  if (url.pathname.endsWith("/mcp") || url.pathname === "/") {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await buildServer(auth.claims.sub ?? "").connect(transport);
    return transport.handleRequest(req);
  }
  return new Response("not found", { status: 404 });
});
