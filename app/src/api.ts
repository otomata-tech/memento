// Minimal REST client to the Memento backend (/api mirror of the MCP verbs).
import { supabase } from "./auth";

/** Session token, or null in anonymous read (public KB). */
async function token(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

/** Authorization header only if a session exists (otherwise anonymous read). */
async function authHeader(): Promise<Record<string, string>> {
  const t = await token();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const res = await fetch(`/api${path}?${qs}`, { headers: await authHeader() });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function send<T>(method: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(await authHeader()), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${path} → ${res.status}`);
  return data as T;
}

export interface Workspace { slug: string; name: string; summary: string }
export interface PinnedWorkspace { id: string; slug: string; name: string; summary: string; org: string | null }
export interface SectionNode {
  id: string; title: string; slug: string; summary: string;
  docCount: number; blockCount: number; children: SectionNode[];
}
export interface Doctrine {
  workspace: { slug: string; name: string; summary: string };
  preamble: string;
  tree: SectionNode[];
  conventions: Record<string, string[]>;
}
export interface DocMeta { id: string; title: string; slug: string; summary: string; kind: string | null; status: string; sectionId?: string }
export interface SectionView {
  section: { id: string; title: string; slug: string; summary: string; depth: number };
  subsections: { id: string; title: string; slug: string; summary: string }[];
  documents: (DocMeta & { blockCount: number })[];
}
export interface BlockSource { sourceId?: string; kind?: string; title: string; ref: string | null; citation: string | null; locator: string | null }
export interface BlockLink { id: string; relation: string; note: string | null; toBlockId?: string; fromBlockId?: string }
export interface BlockComment { id: string; body: string; author: string; authorKind: string; resolvedAt: string | null }
export interface Block {
  id: string; type: string; content: string; position: number; verifiedAt: string | null;
  sources: BlockSource[]; linksFrom: BlockLink[]; linksTo: BlockLink[]; comments: BlockComment[];
}
export interface DocumentView { document: DocMeta; blocks: Block[] }

export interface Revision {
  id: string; targetType: string; targetId: string | null; op: string; reason: string;
  actor: string; actorKind: string; ingestionId: string | null; createdAt: string;
}
export interface ChangeFeedback { author: string; authorKind: string; body: string; at: string }
export interface IngestionChange {
  id: string; op: string; class: string; target: string | null; rationale: string | null;
  payload: Record<string, unknown>; applied: boolean; appliedAt?: string; error?: string;
  feedback?: ChangeFeedback[]; edited?: boolean; editedBy?: string;
}
export interface IngestionCounts { total: number; applied: number; pending: number; errored: number; byClass: Record<string, number> }
export interface IngestionSummary { id: string; title: string; status: string; sourceId: string | null; createdBy: string | null; createdAt: string; counts: IngestionCounts }
export interface InboxItem {
  id: string; url: string | null;
  workspace: string; workspaceName: string; org: string | null; orgName: string | null;
  title: string; status: string; sourceId: string | null;
  createdBy: string | null; createdAt: string; counts: IngestionCounts;
}
export interface IngestionDetail extends IngestionSummary { summary: string; reviewNote: string | null; changes: IngestionChange[]; decidedBy: string | null; decidedAt: string | null }
export interface ChangeEdit { id: string; payload: Record<string, unknown> }
// /ingestion/apply returns per-op outcomes, not the full detail — so the UI can surface errors.
export interface ApplyOpResult { id: string; status: string; reason?: string; error?: string }
export interface ApplyResult { id: string; workspace?: string; status: string; counts: IngestionCounts; results: ApplyOpResult[] }
export interface FeedbackItem { changeId?: string; body: string }
export interface SearchHit { blockId: string; type: string; snippet: string; rank: number; docPath: string; sectionPath: string }
export interface SearchResult { hits: SearchHit[]; total: number }

export interface OrgMember { userId: string; email: string | null; role: string; pending: boolean }
export interface PlatformAccount {
  id: string; email: string; provider: string | null;
  createdAt: string; lastSignInAt: string | null; orgs: string | null;
}
export interface AdminOrg {
  id: string; slug: string; name: string; myRole: string | null; personal: boolean;
  members: OrgMember[];
  workspaces: { slug: string; name: string; visibility: "org" | "private" | "public"; archived: boolean }[];
}
export interface PublicWorkspace { slug: string; name: string; summary: string; org: string | null; orgName: string | null }
export interface PublicSearchHit extends SearchHit { workspace: string | null; org: string | null; docTitle: string; url: string | null }
export interface WorkspaceGrant { userId: string; email: string | null; role: string; pending: boolean }
export interface WorkspaceAccess {
  workspace: string; org: string | null; orgName: string | null;
  visibility: "org" | "private" | "public";
  grants: WorkspaceGrant[];
  inherited: WorkspaceGrant[]; // org members (if visibility=org)
}

export const api = {
  workspaces: () => get<Workspace[]>("/workspaces"),
  doctrine: (workspace: string) => get<Doctrine>("/doctrine", { workspace }),
  section: (id: string) => get<SectionView>("/section", { id }),
  document: (id: string) => get<DocumentView>("/document", { id }),
  documentByPath: (path: string) => get<DocumentView>("/document", { path }),
  block: (id: string) => get<Block & { documentId: string }>("/block", { id }),
  search: (workspace: string, q: string, maxHits = 20) => get<SearchResult>("/search", { workspace, q, maxHits }),
  prefs: () => get<{ defaultWorkspace: string | null }>("/prefs"),
  setDefaultWorkspace: (workspace: string) =>
    send<{ defaultWorkspace: string }>("POST", "/prefs/default-workspace", { workspace }),
  pinned: () => get<PinnedWorkspace[]>("/prefs/pins"),
  pinWorkspace: (workspace: string) => send<{ slug: string; name: string }>("POST", "/prefs/pin", { workspace }),
  unpinWorkspace: (workspace: string) => send<{ slug: string }>("DELETE", "/prefs/pin", { workspace }),
  setDoctrine: (workspace: string, preamble: string) =>
    send<{ workspace: string }>("POST", "/workspace/doctrine", { workspace, preamble }),
  updateWorkspace: (workspace: string, name: string, summary: string) =>
    send<{ workspace: string; name: string; summary: string }>("POST", "/workspace/update", { workspace, name, summary }),
  archiveWorkspace: (workspace: string, archived: boolean) =>
    send<{ workspace: string; archived: boolean }>("POST", "/workspace/archive", { workspace, archived }),
  revisions: (workspace: string, limit = 50) =>
    get<{ count: number; revisions: Revision[] }>("/revisions", { workspace, limit }),
  ingestions: (workspace: string, status?: string) =>
    get<{ count: number; ingestions: IngestionSummary[] }>("/ingestions", { workspace, status }),
  ingestion: (id: string) => get<IngestionDetail>("/ingestion", { id }),
  inbox: () => get<{ count: number; ingestions: InboxItem[] }>("/inbox"),
  // ── Curated writes (curator/admin) — REST mirror of the mem_* verbs ──
  verifyBlock: (id: string, verified = true, reason?: string) =>
    send<{ id: string; verifiedAt: string | null; verifiedBy: string | null }>(
      "POST", "/block/verify", { id, verified, reason }),
  updateBlock: (input: { id: string; content?: string; type?: string; reason?: string }) =>
    send<{ id: string; content: string; type: string }>("POST", "/block/update", { reason: "edited from viewer", ...input }),
  attachSource: (input: { blockId: string; kind: string; title: string; ref?: string; citation?: string; locator?: string; reason?: string }) =>
    send<{ blockId: string; sourceId: string }>("POST", "/block/source", input),
  addComment: (input: { targetType: string; targetId: string; body: string; authorKind?: string }) =>
    send<BlockComment>("POST", "/block/comment", input),
  resolveComment: (id: string) =>
    send<{ id: string; resolvedAt: string | null }>("POST", "/comment/resolve", { id }),
  applyIngestion: (id: string, acceptIds?: string[], edits?: ChangeEdit[]) =>
    send<ApplyResult>("POST", "/ingestion/apply", { id, acceptIds, edits }),
  rejectIngestion: (id: string, reason?: string) =>
    send<{ id: string; status: string }>("POST", "/ingestion/reject", { id, reason }),
  requestChanges: (id: string, input: { note?: string; items?: FeedbackItem[] }) =>
    send<IngestionDetail & { requested: number; hasNote: boolean }>("POST", "/ingestion/request-changes", { id, ...input }),
  // ── Structure (curator/admin) — REST mirror of the restructure verbs ──
  createSection: (input: { workspace: string; parentId?: string; title: string; summary?: string }) =>
    send<{ id: string; slug: string; title: string }>("POST", "/section/create", input),
  renameSection: (input: { id: string; title?: string; summary?: string; slug?: string }) =>
    send<{ id: string; title: string; summary: string; slug: string }>("POST", "/section/rename", input),
  reorder: (input: { parentId?: string; orderedChildIds: string[] }) =>
    send<{ reordered: string; count: number }>("POST", "/section/reorder", input),
  createDocument: (input: { sectionId: string; title: string; summary?: string; kind?: string; blocks?: string; reason?: string }) =>
    send<{ document: DocMeta }>("POST", "/document/create", input),
  deprecateDocument: (input: { id: string; reason: string; supersededBy?: string }) =>
    send<{ id: string; status: string }>("POST", "/document/deprecate", input),
  restoreDocument: (input: { id: string; reason?: string }) =>
    send<{ id: string; status: string }>("POST", "/document/restore", input),
  moveDocuments: (input: { documentIds: string[]; targetSectionId: string; dryRun?: boolean }) =>
    send<{ moved: number }>("POST", "/documents/move", input),
  deleteDocument: (input: { id: string; reason?: string }) =>
    send<{ deleted: string; blocks: number }>("DELETE", "/document", input),
  deleteSection: (input: { id: string; reason?: string }) =>
    send<{ deleted: string; sections: number; documents: number }>("DELETE", "/section", input),
  moveDocumentsCross: (input: { documentIds: string[]; targetSectionId: string }) =>
    send<{ moved: number }>("POST", "/documents/move-cross", input),
  moveSectionCross: (input: { sectionId: string; targetWorkspace: string; targetParentId?: string }) =>
    send<{ movedSections: number }>("POST", "/section/move-cross", input),
  admin: {
    orgs: () => get<{ orgs: AdminOrg[] }>("/admin/orgs"),
    accounts: () => get<{ count: number; accounts: PlatformAccount[] }>("/admin/accounts"),
    createOrg: (name: string) =>
      send<{ slug: string; name: string; myRole: string }>("POST", "/admin/orgs", { name }),
    deleteOrg: (orgSlug: string) =>
      send<{ deleted: string }>("DELETE", "/admin/orgs", { orgSlug }),
    invite: (orgSlug: string, email: string, role: string) =>
      send<{ orgSlug: string; email: string; role: string; provisioned: boolean; emailSent: boolean; inviteLink: string | null }>(
        "POST", "/admin/invite", { orgSlug, email, role }),
    resendInvite: (orgSlug: string, email: string) =>
      send<{ email: string; emailSent: boolean }>("POST", "/admin/invite/resend", { orgSlug, email }),
    inviteLink: (orgSlug: string, email: string) =>
      send<{ email: string; link: string }>("POST", "/admin/invite/link", { orgSlug, email }),
    createWorkspace: (orgSlug: string, name: string, summary: string) =>
      send<{ slug: string; name: string; orgSlug: string }>("POST", "/admin/workspaces", { orgSlug, name, summary }),
    transferWorkspace: (toOrg: string, workspace: string) =>
      send<{ workspace: string; toOrg: string }>("POST", "/admin/workspaces/transfer", { workspace, toOrg }),
    removeMember: (orgSlug: string, userId: string) =>
      send<{ removed: string }>("DELETE", "/admin/members", { orgSlug, userId }),
  },
  // ── Scope per KB (issue #60) — reserved for KB admins ──
  grants: (workspace: string) => get<WorkspaceAccess>("/workspace/grants", { workspace }),
  grant: (workspace: string, email: string, role: string) =>
    send<{ workspace: string; email: string; role: string; provisioned: boolean; emailSent: boolean; inviteLink: string | null }>(
      "POST", "/workspace/grants", { workspace, email, role }),
  revokeGrant: (workspace: string, userId: string) =>
    send<{ workspace: string; removed: string }>("DELETE", "/workspace/grants", { workspace, userId }),
  setVisibility: (workspace: string, visibility: "org" | "private" | "public") =>
    send<{ workspace: string; visibility: string }>("POST", "/workspace/visibility", { workspace, visibility }),
  // ── Public surface (no auth): gallery + search of public KBs ──
  public: {
    workspaces: () => get<PublicWorkspace[]>("/public/workspaces"),
    search: (q: string, maxHits = 30) =>
      get<{ hits: PublicSearchHit[]; total: number; hasMore: boolean }>("/public/search", { q, maxHits }),
  },
};

// ── Agent mode (chat on a public KB) — function `agent`, SSE ──
// Surface separate from REST (/api): streaming on /agent/chat, no auth.
export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "status"; tool: string }
  | { type: "done"; steps: number }
  | { type: "error"; message: string };

export type AgentChatMessage = { role: "user" | "assistant"; content: string };

/** POST /agent/chat via SSE. Calls `onEvent` as events arrive (token/status/done/error). */
export async function agentChat(
  workspace: string,
  message: string,
  history: AgentChatMessage[],
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/agent/chat", {
    method: "POST",
    headers: { ...(await authHeader()), "content-type": "application/json", "accept": "text/event-stream" },
    body: JSON.stringify({ workspace, message, history }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `agent → ${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        const payload = JSON.parse(data);
        if (event === "token") onEvent({ type: "token", text: payload.text ?? "" });
        else if (event === "status") onEvent({ type: "status", tool: payload.tool ?? "" });
        else if (event === "done") onEvent({ type: "done", steps: payload.steps ?? 0 });
        else if (event === "error") onEvent({ type: "error", message: payload.message ?? "error" });
      } catch { /* partial/non-JSON chunk, ignored */ }
    }
  }
}
