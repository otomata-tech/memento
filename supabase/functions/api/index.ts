/**
 * Memento REST — Supabase Edge Function (Deno). Mirror of the `mem_*` verbs on top
 * of the shared services layer (`../_shared/`), for server-to-server and the
 * viewer. Same query params as the MCP surface (id | path, workspace, q...).
 *
 * Once deployed, the "api" function answers on /api/*. Locally: deno run -A .../api/index.ts
 */
import { listWorkspaces, listPublicWorkspaces, getDoctrine } from "../_shared/workspaces.ts";
import { getSection } from "../_shared/sections.ts";
import { getDocument, getBlock } from "../_shared/documents.ts";
import { searchBlocks, searchPublic } from "../_shared/search.ts";
import { listRevisions } from "../_shared/revisions.ts";
import { verifyBlock, attachSource, addComment, resolveComment, addDocument, deprecateDocument, restoreDocument, updateDocument, deleteDocument, updateBlock } from "../_shared/write.ts";
import { createSection, renameSection, reorder, moveDocuments, deleteSectionCascade, moveDocumentsCrossWorkspace, moveSectionCrossWorkspace } from "../_shared/restructure.ts";
import { getIngestion, listIngestions, listInbox, applyIngestion, rejectIngestion, requestChanges } from "../_shared/ingestion.ts";
import {
  listMyOrgs, removeMember, inviteMember, createWorkspace, createOrg, updateOrg, deleteOrg, deleteWorkspace,
  resendInvite, inviteLinkFor, transferWorkspace, ensureDefaultWorkspace, ensureAccount,
} from "../_shared/admin.ts";
import { getDefaultWorkspace, setDefaultWorkspace, listPins, pinWorkspace, unpinWorkspace } from "../_shared/prefs.ts";
import { listAccounts } from "../_shared/platform.ts";
import { listGrants, grantAccess, revokeGrant, setVisibility } from "../_shared/grants.ts";
import { logUsage, listUsageLogs } from "../_shared/usage_log.ts";
import { listAgentChatLogs } from "../_shared/agent_log.ts";
import { setDoctrine, updateWorkspace, archiveWorkspace } from "../_shared/workspace_mgmt.ts";
import { authenticate } from "../_shared/auth.ts";
import { assertAccess, assertWorkspaceAdmin, accessibleWorkspaceIds, AccessError, safeErrorMessage } from "../_shared/access.ts";
import { assertWithinLimit, RateLimitError } from "../_shared/ratelimit.ts";

/** Origins allowed to call the API cross-origin (the viewer goes through a
 *  same-origin proxy and doesn't need it). No `*`: we only reflect a known
 *  origin. */
const ALLOWED_ORIGINS = new Set(
  [
    Deno.env.get("MEMENTO_APP_URL"),
    Deno.env.get("MEMENTO_PUBLIC_URL"),
    "https://mento.cc",
    "https://me.mento.cc",
    "http://localhost:5188",
    "http://localhost:5173",
  ]
    .filter((u): u is string => !!u)
    .map((u) => {
      try { return new URL(u).origin; } catch { return u; }
    }),
);

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "vary": "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) h["access-control-allow-origin"] = origin;
  return h;
}

function jsonRes(data: unknown, status = 200, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors },
  });
}

/** Routes reserved for logged-in accounts even on a public KB: the
 *  editorial/audit layer (revision log, ingestion queue) carries the identity of
 *  contributors — not public data. Reading content, on the other hand, is open. */
function requireAuthenticated(sub: string): void {
  if (!sub) throw new AccessError("resource not found or access denied");
}

async function route(path: string, q: URLSearchParams, sub: string): Promise<unknown> {
  const id = q.get("id") ?? undefined;
  const p = q.get("path") ?? undefined;
  switch (path) {
    // ── PUBLIC surface (no auth): gallery + search of public KBs ──
    case "/public/workspaces":
      return listPublicWorkspaces();
    case "/public/search":
      await assertWithinLimit(sub, "search_public"); // anonymous (sub="") = no-op, bounded by WAF
      return searchPublic({
        q: q.get("q") ?? "",
        blockType: q.get("blockType") ?? undefined,
        docKind: q.get("docKind") ?? undefined,
        maxHits: q.get("maxHits") ? Number(q.get("maxHits")) : undefined,
      });
    case "/workspaces":
      // Onboarding: a logged-in account with no KB gets one created (personal org, private).
      await ensureDefaultWorkspace(sub); // anonymous (sub="") = no-op
      return listWorkspaces({ ids: await accessibleWorkspaceIds(sub) });
    case "/prefs":
      return { defaultWorkspace: (await getDefaultWorkspace(sub))?.slug ?? null };
    case "/prefs/pins":
      requireAuthenticated(sub);
      return listPins(sub);
    case "/admin/orgs":
      return listMyOrgs(sub);
    case "/admin/accounts":
      // Gating in listAccounts: platform operators (MEMENTO_PLATFORM_ADMINS).
      return listAccounts(sub);
    case "/workspace/grants":
      // Gating in listGrants: effective admin of the base.
      return listGrants(sub, { workspace: q.get("workspace")! });
    case "/doctrine":
      await assertAccess(sub, { workspace: q.get("workspace")! });
      return getDoctrine(q.get("workspace")!);
    case "/section":
      await assertAccess(sub, p ? { path: p } : { id, kind: "section" });
      return getSection({ id, path: p });
    case "/document":
      await assertAccess(sub, p ? { path: p } : { id, kind: "document" });
      return getDocument({ id, path: p });
    case "/block":
      await assertAccess(sub, { id: q.get("id")!, kind: "block" });
      return getBlock(q.get("id")!);
    case "/search":
      await assertAccess(sub, { workspace: q.get("workspace")! });
      return searchBlocks({
        workspace: q.get("workspace")!,
        q: q.get("q") ?? "",
        blockType: q.get("blockType") ?? undefined,
        sectionPath: q.get("sectionPath") ?? undefined,
        docKind: q.get("docKind") ?? undefined,
        maxHits: q.get("maxHits") ? Number(q.get("maxHits")) : undefined,
      });
    case "/revisions":
      requireAuthenticated(sub);
      await assertAccess(sub, { workspace: q.get("workspace")! });
      return listRevisions({
        workspace: q.get("workspace")!,
        targetType: q.get("targetType") ?? undefined,
        targetId: q.get("targetId") ?? undefined,
        since: q.get("since") ?? undefined,
        limit: q.get("limit") ? Number(q.get("limit")) : undefined,
      });
    case "/ingestions":
      requireAuthenticated(sub);
      await assertAccess(sub, { workspace: q.get("workspace")! });
      return listIngestions({ workspace: q.get("workspace")!, status: q.get("status") ?? undefined });
    case "/ingestion":
      requireAuthenticated(sub);
      await assertAccess(sub, { id: q.get("id")!, kind: "ingestion" });
      return getIngestion(q.get("id")!);
    case "/inbox":
      // Cross-org/cross-KB: pending ingestions across every workspace the user can access.
      requireAuthenticated(sub);
      return listInbox(await accessibleWorkspaceIds(sub));
    case "/usage-logs":
      // Scoping in listUsageLogs: my logs, or a KB's logs if admin/curator.
      return listUsageLogs({
        workspace: q.get("workspace") ?? undefined,
        verb: q.get("verb") ?? undefined,
        kind: q.get("kind") ?? undefined,
        limit: q.get("limit") ? Number(q.get("limit")) : undefined,
      }, sub);
    case "/agent-logs":
      // Transcript of the public agent for a KB — curator/admin only (gated in the service).
      requireAuthenticated(sub);
      return listAgentChatLogs({
        workspace: q.get("workspace")!,
        noHits: q.get("noHits") === "1" || q.get("noHits") === "true",
        limit: q.get("limit") ? Number(q.get("limit")) : undefined,
      }, sub);
    default: return null;
  }
}

/** Mutating routes (admin + preferences) — POST/DELETE with JSON body. */
async function mutationRoute(method: string, path: string, body: any, sub: string): Promise<unknown> {
  switch (`${method} ${path}`) {
    case "POST /admin/invite": return inviteMember(sub, body);
    case "POST /admin/invite/resend": return resendInvite(sub, body);
    case "POST /admin/invite/link": return inviteLinkFor(sub, body);
    case "POST /admin/orgs": return createOrg(sub, body);
    case "POST /admin/orgs/update": return updateOrg(sub, body);
    case "DELETE /admin/orgs": return deleteOrg(sub, body);
    case "POST /admin/workspaces": return createWorkspace(sub, body);
    case "POST /admin/workspaces/transfer": return transferWorkspace(sub, body);
    case "DELETE /admin/members": return removeMember(sub, body);
    case "POST /prefs/default-workspace": {
      const w = await setDefaultWorkspace(sub, body.workspace);
      return { defaultWorkspace: w.slug, name: w.name };
    }
    case "POST /prefs/pin":
      requireAuthenticated(sub);
      return pinWorkspace(sub, body.workspace); // assertAccess (read) inside the fn
    case "DELETE /prefs/pin":
      requireAuthenticated(sub);
      return unpinWorkspace(sub, body.workspace);
    case "POST /workspace/doctrine":
      await assertAccess(sub, { workspace: body.workspace }, { write: true });
      return setDoctrine(body, sub);
    case "POST /workspace/update":
      await assertAccess(sub, { workspace: body.workspace }, { write: true });
      return updateWorkspace(body, sub);
    case "DELETE /workspace":
      // Hard-delete a whole KB — org-admin + archived-first checks live inside deleteWorkspace.
      return deleteWorkspace(sub, body);
    case "POST /workspace/archive":
      await assertWorkspaceAdmin(sub, body.workspace);
      return archiveWorkspace(body, sub);
    // ── Per-KB scope (effective admin gating in the services, issue #60) ──
    case "POST /workspace/grants": return grantAccess(sub, body);
    case "DELETE /workspace/grants": return revokeGrant(sub, body);
    case "POST /workspace/visibility": return setVisibility(sub, body);
    // ── Curated writes (admin/curator only, gated by assertAccess write) ──
    case "POST /block/verify":
      await assertAccess(sub, { id: body.id, kind: "block" }, { write: true });
      return verifyBlock(body, sub);
    case "POST /block/update":
      await assertAccess(sub, { id: body.id, kind: "block" }, { write: true });
      return updateBlock(body, sub);
    case "POST /block/source":
      await assertAccess(sub, { id: body.blockId, kind: "block" }, { write: true });
      return attachSource(body, sub);
    case "POST /block/comment":
      await assertAccess(sub, { id: body.targetId, kind: body.targetType.toLowerCase() }, { write: true });
      return addComment(body, sub);
    case "POST /comment/resolve":
      await assertAccess(sub, { id: body.id, kind: "comment" }, { write: true });
      return resolveComment({ id: body.id });
    // ── Structure (curator/admin only, gated by assertAccess write) — REST mirror of restructure verbs ──
    case "POST /section/create":
      await assertAccess(sub, { workspace: body.workspace }, { write: true });
      return createSection(body, sub);
    case "POST /section/rename":
      await assertAccess(sub, { id: body.id, kind: "section" }, { write: true });
      return renameSection(body, sub);
    case "POST /section/reorder":
      // reorder asserts write access on the real (anchored) entity itself.
      return reorder(body, sub);
    case "POST /document/create":
      await assertAccess(sub, { id: body.sectionId, kind: "section" }, { write: true });
      return addDocument(body, sub);
    case "POST /document/deprecate":
      await assertAccess(sub, { id: body.id, kind: "document" }, { write: true });
      return deprecateDocument(body, sub);
    case "POST /document/restore":
      await assertAccess(sub, { id: body.id, kind: "document" }, { write: true });
      return restoreDocument(body, sub);
    case "POST /document/update":
      await assertAccess(sub, { id: body.id, kind: "document" }, { write: true });
      return updateDocument(body, sub);
    case "POST /documents/move":
      // Same-workspace move: write on the target section ⇒ same KB ⇒ covers source.
      await assertAccess(sub, { id: body.targetSectionId, kind: "section" }, { write: true });
      return moveDocuments(body, sub);
    // ── Cross-workspace / cross-org moves (write on BOTH sides) ──
    case "POST /documents/move-cross": {
      await assertAccess(sub, { id: body.targetSectionId, kind: "section" }, { write: true });
      for (const id of (body.documentIds ?? [])) await assertAccess(sub, { id, kind: "document" }, { write: true });
      return moveDocumentsCrossWorkspace(body, sub);
    }
    case "POST /section/move-cross":
      await assertAccess(sub, { id: body.sectionId, kind: "section" }, { write: true });
      await assertAccess(sub, { workspace: body.targetWorkspace }, { write: true });
      return moveSectionCrossWorkspace(body, sub);
    // ── Hard delete (irreversible) — curator/admin, like the other structural verbs ──
    case "DELETE /document":
      await assertAccess(sub, { id: body.id, kind: "document" }, { write: true });
      return deleteDocument({ id: body.id, reason: body.reason }, sub);
    case "DELETE /section":
      await assertAccess(sub, { id: body.id, kind: "section" }, { write: true });
      return deleteSectionCascade({ id: body.id, reason: body.reason }, sub);
    case "POST /ingestion/apply":
      await assertAccess(sub, { id: body.id, kind: "ingestion" }, { write: true });
      return applyIngestion(body, sub);
    case "POST /ingestion/reject":
      await assertAccess(sub, { id: body.id, kind: "ingestion" }, { write: true });
      return rejectIngestion(body, sub);
    case "POST /ingestion/request-changes":
      await assertAccess(sub, { id: body.id, kind: "ingestion" }, { write: true });
      return requestChanges(body, sub);
    case "POST /usage-log":
      // Product feedback: open to any authenticated user, no role required.
      return logUsage(body, sub);
    default: return null;
  }
}

Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000) }, async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = new URL(req.url);
  // Strip the function's routing prefix (/api) if present.
  const path = url.pathname.replace(/^\/api/, "") || "/";
  if (path === "/health") return new Response("ok", { headers: cors });
  // oto→memento federation (otomata#16): an account created on oto requests the creation
  // of the matching memento account (joined by email). Authenticated by the shared
  // SERVICE SECRET (MEMENTO_PROVISION_BEARER), NOT by the user's OAuth — before
  // authenticate(). memento stays the owner of the creation (ensureAccount).
  if (path === "/federation/provision" && req.method === "POST") {
    const secret = Deno.env.get("MEMENTO_PROVISION_BEARER");
    const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!secret || got !== secret) return jsonRes({ error: "forbidden" }, 403, cors);
    const body = await req.json().catch(() => ({})) as { email?: string };
    const email = (body.email ?? "").trim();
    if (!email) return jsonRes({ error: "email required" }, 400, cors);
    try {
      const r = await ensureAccount(email);
      return jsonRes({ ok: true, provisioned: r.provisioned, sub: r.sub }, 200, cors);
    } catch (e) {
      console.error("[api] federation/provision:", e);
      return jsonRes({ error: safeErrorMessage(e) }, 500, cors);
    }
  }
  // Anonymous read allowed (GET): without a token, we continue with sub="" and each
  // route stays guarded by assertAccess → only the `public` scope passes (response
  // indistinguishable from a denial otherwise). Mutations always require a valid token.
  const auth = await authenticate(req);
  if (!auth.ok && req.method !== "GET") return jsonRes({ error: auth.message }, auth.status, cors);
  const sub = auth.ok ? (auth.claims.sub ?? "") : "";
  try {
    const data = req.method === "GET"
      ? await route(path, url.searchParams, sub)
      : await mutationRoute(req.method, path, await req.json().catch(() => ({})), sub);
    if (data === null) return jsonRes({ error: `unknown route: ${path}` }, 404, cors);
    return jsonRes(data, 200, cors);
  } catch (e) {
    if (e instanceof AccessError) return jsonRes({ error: e.message }, 403, cors);
    if (e instanceof RateLimitError) return jsonRes({ error: e.message }, 429, cors);
    console.error(`[api] ${req.method} ${path}:`, e);
    return jsonRes({ error: safeErrorMessage(e) }, 400, cors);
  }
});
