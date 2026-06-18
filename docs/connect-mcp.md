# Connecting Memento (MCP)

Guide to wiring the Memento knowledge base to an MCP client (claude.ai, Claude
Desktop, Claude Code, others). The server is **remote, OAuth-authenticated** —
nothing to install locally.

## Prerequisites

1. **An account** on `me.mento.cc` (Supabase login). If you received an
   **invitation link**, open it once: it creates your account and signs you in to
   the viewer.
2. **Being a member of an organization** that owns at least one base (workspace).
   Otherwise the server connects but `mem_workspaces` returns an empty list
   (access to nothing). Ask an admin to add you (UI `/admin` → Invite).

MCP endpoint: **`https://mcp.mento.cc/mcp`**

## claude.ai (web) / Claude Desktop

1. **Settings → Connectors → Add custom connector**.
2. Paste the URL `https://mcp.mento.cc/mcp`. Name: `Memento`.
3. Confirm → an OAuth window opens:
   - the client registers itself (DCR);
   - **sign in** with your Memento account (Supabase);
   - **consent page** → "Authorize".
4. The connector turns "connected". The `mem_*` tools appear.

> If you don't see new verbs after a server update: **disconnect /
> reconnect** the connector (the tool list is frozen at connection time).

## Claude Code (CLI)

```bash
claude mcp add memento https://mcp.mento.cc/mcp --transport http
```
On the first call, Claude Code opens the browser for OAuth (Supabase login +
consent), then caches the token. Verify: `claude mcp list`.

## Other clients (Mistral Le Chat, ChatGPT)

The server is **client-agnostic**: any MCP client handling a remote server over
**OAuth 2.1 + DCR** (RFC 7591) and **RFC 9728** (`401` + `WWW-Authenticate` →
PRM) wires up without any change on the Memento side. Validated live on
**2026-06-17** on Le Chat *and* ChatGPT.

### Mistral Le Chat

1. **Connectors** → **+ Add Connector** → **Custom MCP Connector** tab.
2. **Server URL**: `https://mcp.mento.cc/mcp` — name: `Memento` → **Connect**.
3. Auth auto-detection → Supabase OAuth flow (login + consent).

- **Admin-only** feature; on Free/Pro/Student the account owner is admin by default.
- **No dynamic tool discovery**: tool list frozen at connection time → after a
  server update, disconnect/reconnect to see the new verbs.

### ChatGPT (Developer Mode)

1. **Settings → Apps & Connectors → Advanced settings → Developer Mode** (ON).
2. **Create** → **MCP Server URL**: `https://mcp.mento.cc/mcp`, **Authentication**: OAuth.
3. Supabase OAuth flow → enable the `mem_*` tools in the connector card.

- **Plus / Pro / Business / Enterprise / Edu** plans, **web only**.
- **DCR supported** (not only CIMD); **no `search`/`fetch` requirement** — all
  the `mem_*` verbs pass. **Write actions** are confirmed by default (matches the
  propose-validate loop).
- The *"Enforce CSP in developer mode"* toggle only concerns **rendered-UI MCP
  Apps** (widgets/iframes) → **no impact** on Memento (tools-only, JSON/text
  returns).

> Residual risk common to both clients: rendering the Supabase consent page
> (`/oauth/consent`) in their webview. If OAuth loops, that's where to dig —
> on the Memento side (redirect/consent), not the protocol side.

## First steps (doctrine-first)

The server is **stateless**: you always name the base. Recommended flow that the
agent follows:

1. `mem_workspaces` — lists the bases **you** have access to.
2. `mem_doctrine({ workspace: "<slug>" })` — the map: preamble + section tree + conventions.
3. Drill: `mem_section` / `mem_document` / `mem_block` (by `id` or `path` — the
   `path` starts with the base slug), or `mem_search({ workspace, q })` (full-text
   per block).

Example prompt: "With Memento, give me the map of the `demo` base, then what the
criterion HAS 1.7.4 says, sourced."

## Writing & the propose-validate loop

Reserved for the org's **admin / curator** roles. The agent never mutates blind:
it **proposes** a change-set (`mem_stage_changes`) → a human reviews it
(*Ingestions* view of the viewer or `mem_ingestion_get`) → applies
(`mem_apply_ingestion`) or rejects. Contradictions are never applied
automatically.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Connection OK but `mem_workspaces` empty | Not a member of an org owning a base → request access. |
| `401` / re-prompts login | Token expired → restart the OAuth flow (reconnect the connector). |
| "Access denied to this workspace" | The base belongs to an org you're not a member of. |
| Write `isError` "reserved for admin/curator" | Your role is `member` (read-only). |
| New verbs missing | Tool list frozen → disconnect / reconnect the connector. |

## Technical pointers (for the admin)

- Auth: Supabase OAuth 2.1 + DCR; the function is an RFC 9728 resource server
  (PRM on `/.well-known/oauth-protected-resource`, ES256 JWKS verification).
  Details: `docs/deployment-edge.md`.
- Per-workspace access via orgs/memberships. Management: UI `/admin` or CLI
  `npm run admin`. See `docs/access-control.md`.
