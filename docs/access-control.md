# Access control

Who accesses which KB. **Supersedes spec §2.7** (isolation via Logto
Organizations, dropped with the Supabase migration). **Rework from issue #60
(2026-06-12)**: the org = tenant; each KB carries its own perimeter.

## Model

| Table | Role |
|---|---|
| `mem_orgs` (slug, name, personal_for) | a **tenant** (member directory); `personal_for` = the user's auto-provisioned personal org (sub, unique; null = normal org) |
| `mem_memberships` (org_id, user_id, role) | Supabase user (`sub`) ↔ org, composite PK |
| `mem_workspaces.org_id` → `mem_orgs` | each KB belongs to ONE org (tenant) |
| `mem_workspaces.visibility` | `org` (org members, org role by default) \| `private` (grants only) \| `public` (world read, anonymous included + gallery + public search) |
| `mem_workspace_grants` (workspace_id, user_id, role) | explicit access to ONE KB — elevating a member, restricting via private, **external guest** |

Rules (decision 2026-06-12):
- **Content access**: effective role = max(explicit grant, org role if `visibility=org`) — `effectiveRole()` in `_shared/access.ts`. Granularity = whole workspace (no per-section, no fractal ACLs).
- **Governance** (share, visibility, archive, transfer) = **admin of the OWNING ORG only** (`assertWorkspaceAdmin`). A grant only confers `member` (read) or `curator` (write) — never governance; transfer requires the admin of BOTH orgs (anti-exfiltration).
- A `private` KB: content invisible without a grant, but its **existence** is visible to org-admins (otherwise ungovernable) — `myRole: null` in the topology. Going private sets a `curator` grant for the caller (they keep read access; governance stays theirs via the org).
- A `public` KB: **read (`member`) for EVERYONE, anonymous included** (`effectiveRole` returns `member` even for `sub === ""`). The owning org **keeps its org role** (it curates its public base); grants always elevate. It is a superset of `org` + world read, never a downgrade. Public KBs from other orgs **do not enter** "my bases" (`accessibleWorkspaceIds`) — they are discovered through the **public gallery** or **public search**, or by pinning them (`mem_use_workspace`). Writing stays curator/admin → the anonymous user can never mutate.

### Public surfaces (no auth)

- **Web viewer**: `api/index.ts` accepts **anonymous GETs** (token absent ⇒ `sub=""`); each route stays guarded by `assertAccess`, so only the `public` perimeter responds (otherwise an indistinct refusal). Mutations (POST/DELETE) always require a valid token. Open routes: `GET /public/workspaces` (directory) and `GET /public/search?q=` (full-text search over all public KBs). The frontend: route `/public` (`PublicGalleryView`), and `/w/:ws` readable without a session (the revision journal is hidden from the anonymous user — no leak of identities).
- **MCP**: stays **authenticated** (OAuth). A signed-in user reads a public KB by naming it (slug / `mem_use_workspace`) — `effectiveRole` opens read access — or discovers it via the **`mem_public_search`** verb (search over all public KBs, no membership required). We **do not expose** MCP anonymously.
- **Rate limit**: `search_public` (60/min) only counts authenticated calls (empty `sub` = no-op); the anonymous user is bounded by the Cloudflare WAF/IP on `me.mento.cc/api`.

**Personal org**: provisioned on first topological access (`ensurePersonalOrg`, idempotent, `personal_for` unique) — "Personal (xxx)", the user is its admin. Any account (guests included) can therefore create its own KBs at home and promote them later (transfer = change of tenant).

## Roles

| role | read | write (Lot 2) |
|---|---|---|
| `member` | yes | no |
| `curator` | yes | yes |
| `admin` | yes | yes |

Ranks in `supabase/functions/_shared/access.ts` (`ROLE_RANK`); write = rank ≥ curator.

## Enforcement

- `_shared/access.ts`: `effectiveRole(sub, wsId)`, `accessibleWorkspaceIds(sub)` (org-visible ∪ granted), `assertAccess(sub, ref, {write?})`, `assertWorkspaceAdmin(sub, slug)` (**admin of the owning org** — governance).
- `ref` resolves the targeted workspace from `{workspace}` (slug) | `{path}` | `{id, kind: section|document|block|ingestion|link|comment}`.
- Wired in `supabase/functions/mcp/index.ts` (`buildServer(sub)`, each verb guarded) and `api/index.ts` (per route). `mem_workspaces` is filtered; refusal → 403 / `isError`.
- **Composite ops**: authorize on the REAL resolved entities, not an anchor supplied by the caller (cf. the `mem_reorder` IDOR fix).
- The `sub` comes from the JWT verified (JWKS) by `authenticate()`.

## Sharing: the perimeter is set on the KB (by the org-admin)

UI gesture: **Share** button in the viewer toolbar (org-admins) or `/org/:slug/bases` → "share" — `SharePanel.vue` component (perimeter + unified "who has access" grants/inherited + invitation). Agent verbs: `mem_grants` (op list|grant|revoke) / `mem_workspace_admin` (op set_visibility).

- **The whole team**: `visibility=org` (default) — org members access with their org role (`inherited` in `mem_grants`).
- **Subset / personal within the team**: `visibility=private` + grants.
- **External (guest)**: `mem_grants({op:"grant", workspace, email, role: member|curator})` — account provisioned + invitation email (same GoTrue flow as org members, grant landing). They see the KB under "Shared with me" (org menu + `shared` from `mem_workspaces`), without joining the org.
- **Open to all (public)**: `visibility=public` (`mem_workspace_admin({op:"set_visibility", visibility:"public"})` or the "Public" option of the SharePanel) — read/search by anyone, no account (gallery `/public` + `mem_public_search`). Reserved for the org-admin (governance). Writing stays with the org/curators.
- **Change tenant** (promote a personal KB → team, hand back to the client): `mem_workspace_admin({op:"transfer", workspace, toOrg})` — admin of both orgs. The perimeter (visibility/grants) follows the KB.

## Admin CLI — `npm run admin`

Targets the DB pointed at by `DATABASE_URL` (Supabase direct for prod, local otherwise). `email→sub` resolved via `auth.users` (present only on Supabase).

```bash
npm run admin -- whoami <email>                  # a user's Supabase sub from email
npm run admin -- org-create <slug> <name>
npm run admin -- member-add <org-slug> <email|sub> <role>   # role = admin|curator|member
npm run admin -- ws-assign <ws-slug> <org-slug>
npm run admin -- list
```

Prod: export `DATABASE_URL` (the direct Postgres URL of your project) from your secret vault, then `npm --prefix server run admin -- <cmd>`.
The CLI has no `member-remove`/`org-create-ws` → for those cases, a one-off `tsx` script in `server/` (import `db` from `./src/db.js`).

## Admin UI (SPA `/admin`) — `_shared/admin.ts`

**UI**: per-org pages on `/org/:slug/(bases|membres|reglages)` (tabs); org switched
from the bar (menu near the account: my orgs, ⚙ manage, + new organization); the
base selector only shows the bases of the current org; `/admin` redirects (compat).
**API** — manages **orgs and members** without the CLI: `GET /admin/orgs` (the caller's orgs + members + bases),
`POST /admin/orgs` (create an org — the creator becomes admin; `DELETE` if the org is empty),
`POST /admin/invite` (new account → **invitation email** GoTrue `/invite` via custom SMTP;
fallback link to forward if sending fails), `POST /admin/invite/resend` (magic link) and
`/admin/invite/link` (manual link — ⚠ one-shot, WhatsApp/Slack previews can consume it),
`DELETE /admin/members` (last-admin anti-lockout), `POST /admin/workspaces` (create a KB).
A **pending** member = provisioned, `last_sign_in_at` null. When the link arrives (`/callback`,
`type=invite`), the viewer offers to **set a password** (account provisioned without a password —
otherwise sign-in is by magic link only). Doctrine/metadata/archive editing:
`_shared/workspace_mgmt.ts` + `POST /workspace/doctrine|update|archive`. All gated org-admin
(orgs/members/KB) or curator (doctrine). SMTP/OTP: see `deployment-edge.md` § Auth.
