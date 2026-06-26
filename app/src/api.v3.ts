/**
 * Memento V3 — client REST page-centré (miroir des 8 verbes MCP, face REST ADR 0009).
 * CONTRAT FIGÉ : les vues v3 (PagesView/SearchView/InboxView) codent contre CE module,
 * la face REST `supabase/functions/api-v3` l'implémente trait pour trait. Mêmes types
 * que `server/src/mcp-contract.v3.ts` (recopiés ici pour l'indépendance du build front).
 *
 * Auth : Bearer du token Supabase (session). Chemins `/api/v3/*` proxifiés par Caddy
 * vers `functions/v1/api-v3/*` → same-origin, pas de CORS.
 */
import { supabase } from "./auth";

// ── Types du contrat (recopiés de mcp-contract.v3.ts) ─────────────────────────
export type EntityType = "personne" | "entreprise" | "outil" | "decision";
export type Visibility = "private" | "org" | "public";
export type GrantMode = "read" | "write";
export type Scope = "savoir" | "sources" | "both";
export type ListKind = "pages" | "entities" | "sources" | "ingestions" | "entity_review";

export interface BaseRef { id: string; name: string; orgId: string; role: string }
export interface EntityRef { id: string; type: EntityType; label: string }
export interface TreeNode { id: string; title: string; description: string; children?: TreeNode[] }
export interface LoadResult {
  guide: string;
  tree: TreeNode[];
  topEntities: EntityRef[];
  counts: { pages: number; entities: number; sources: number };
  etag: string;
}
export interface SearchHit {
  pageId: string; title: string; description: string; passage: string;
  occurredAt: string | null; score: number; matchedBy: ("semantic" | "lexical")[]; entities: EntityRef[];
}
export interface PageSource { id: string; kind: string; title: string; uri: string | null; citation: string | null; locator: string | null }
export interface PageChild { id: string; title: string; description: string }
export interface PageDetail {
  kind: "page"; id: string; base_id: string; parent_id: string | null;
  title: string; description: string; body: string; visibility: Visibility;
  occurred_at: string | null; status: string; created_at: string; updated_at: string;
  children?: PageChild[]; entities?: EntityRef[]; sources?: PageSource[];
}
export interface EntityMention { page_id: string; span: string | null; confidence: number; title: string }
export interface EntityDetail {
  kind: "entity"; id: string; org_id: string; type: EntityType;
  canonical_label: string; normalised_label: string; aliases: string[];
  page_id: string | null; is_stub: boolean; attributes: Record<string, unknown> | null;
  mentions?: EntityMention[];
}
export interface IngestionRow { id: string; title: string; status: string; created_at: string }
export interface ListResult<T = unknown> { items: T[]; totalCount: number; cursor: string | null }
export interface Digest {
  orgId: string; sinceDays: number;
  recentPages: { id: string; title: string; description: string; updatedAt: string }[];
  recentDecisions: unknown[]; openDecisions: unknown[];
  revisions: { targetType: string; op: string; actor: string; at: string }[];
}
export type GetInclude = "children" | "backlinks" | "sources";

// ── Admin org/équipe (verbe unique `admin`, issue #71) ────────────────────────
export type OrgRole = "admin" | "member";
export interface OrgMember { userId: string; email: string | null; role: string; pending: boolean }
export interface AdminOrg {
  id: string; slug: string; name: string; myRole: string | null; personal: boolean;
  base: { id: string; name: string } | null;
  members: OrgMember[];
}
export interface InviteResult {
  orgSlug: string; email: string; role: string;
  provisioned: boolean; emailSent: boolean; inviteLink: string | null;
}

// ── Op du change-set (sous-ensemble utile à l'UI : create/update/set_visibility) ──
export type ProposeOp =
  | { op: "create_page"; payload: { parentId: string | null; title: string; description: string; body?: string } }
  | { op: "update_page"; payload: { pageId: string; mode: "append" | "replace"; title?: string; description?: string; body?: string } }
  | { op: "set_visibility"; payload: { pageId: string; visibility: Visibility } };

// ── Transport ─────────────────────────────────────────────────────────────────
async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const res = await fetch(`/api/v3${path}?${qs}`, { headers: await authHeader() });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/v3${path}`, {
    method: "POST",
    headers: { ...(await authHeader()), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${path} → ${res.status}`);
  return data as T;
}

// ── Les verbes (1:1 avec la face REST) ────────────────────────────────────────
export const apiV3 = {
  /** Bases accessibles à l'appelant (corrige l'amorçage : base = UUID non devinable). */
  bases: () => get<{ bases: BaseRef[] }>("/bases").then((r) => r.bases),
  load: (base?: string, depth?: number) => get<LoadResult>("/load", { base, depth }),
  search: (q: string, opts: { scope?: Scope; base?: string; limit?: number } = {}) =>
    get<SearchHit[]>("/search", { q, scope: opts.scope, base: opts.base, limit: opts.limit }),
  getPage: (id: string, include: GetInclude[] = ["children", "backlinks", "sources"]) =>
    get<PageDetail>("/get", { id, kind: "page", include: include.join(",") }),
  getEntity: (id: string, include: GetInclude[] = ["backlinks"]) =>
    get<EntityDetail>("/get", { id, kind: "entity", include: include.join(",") }),
  list: <T = unknown>(kind: ListKind, opts: { base?: string; filters?: Record<string, unknown>; cursor?: string; limit?: number } = {}) =>
    get<ListResult<T>>("/list", { kind, base: opts.base, filters: opts.filters ? JSON.stringify(opts.filters) : undefined, cursor: opts.cursor, limit: opts.limit }),
  count: (kind: ListKind, opts: { base?: string; filters?: Record<string, unknown> } = {}) =>
    get<{ total: number }>("/count", { kind, base: opts.base, filters: opts.filters ? JSON.stringify(opts.filters) : undefined }),
  digest: (base?: string, sinceDays?: number) => get<Digest>("/digest", { base, sinceDays }),
  propose: (args: { title: string; base?: string; changes: ProposeOp[]; clientKey?: string }) =>
    post<{ ingestionId: string; similarExisting: { pageId: string; score: number }[] }>("/propose", args),
  apply: (ingestionId: string) => post<{ status: string }>("/apply", { ingestionId }),
  review: (ingestionId: string, decision: "reject" | "send_back", reviewNote?: string) =>
    post<{ status: string }>("/review", { ingestionId, decision, reviewNote }),
  share: (pageRef: string, to: { visibility: Visibility } | { user: string; mode: GrantMode }) =>
    post<{ ok: true }>("/share", { pageRef, to }),

  // ── Admin org/équipe (verbe unique `admin`) ─────────────────────────────────
  admin: {
    orgs: () => post<{ orgs: AdminOrg[] }>("/admin", { action: "orgs" }).then((r) => r.orgs),
    createOrg: (name: string, opts: { slug?: string; baseName?: string } = {}) =>
      post<{ slug: string; name: string; myRole: string; baseId: string; baseName: string }>(
        "/admin", { action: "create_org", name, ...opts }),
    renameBase: (baseId: string, name: string) =>
      post<{ baseId: string; name: string }>("/admin", { action: "rename_base", baseId, name }),
    invite: (orgSlug: string, email: string, role: OrgRole = "member") =>
      post<InviteResult>("/admin", { action: "invite_member", orgSlug, email, role }),
    setRole: (orgSlug: string, userId: string, role: OrgRole) =>
      post<{ orgSlug: string; userId: string; role: string }>("/admin", { action: "set_role", orgSlug, userId, role }),
    removeMember: (orgSlug: string, userId: string) =>
      post<{ removed: string; orgSlug: string }>("/admin", { action: "remove_member", orgSlug, userId }),
  },
};
