# Memento — dev orientation

Knowledge substrate for agents, consumed via **MCP**. Typed blocks, sourced and linked,
maintained by a propose-validate loop. See [`docs/principles.md`](docs/principles.md) for the why
and [`docs/specs/knowledge-base.md`](docs/specs/knowledge-base.md) for the model + MCP surface.

## Project context

- **Open-core**: this repo is the canonical, **public** (Apache-2.0) home — development happens in the open. The pre-open-core private history is archived at `otomata-tech/memento-legacy`.
- **How it's consumed**: an MCP connector (`mem_*` verbs, OAuth at `https://mcp.mento.cc/mcp`, doctrine-first) wired into claude.ai / ChatGPT / Mistral Le Chat.
- **Companion**: `otomata-tech/memento-plugin` — Claude Code skills (`/memento:*`) for session-learning capture and propose-validate pushes to the KB.
- Detailed prod deployment topology is operator-internal and lives outside this public doc.

## Stack

- **Edge runtime (prod)**: Deno — `supabase/functions/{mcp,api}` over `_shared/` (db, auth, write, search, access). Auth via JWT (OAuth/OIDC). No LLM server-side: reads are deterministic; embeddings (optional) power hybrid search.
- **Schema/tooling (Node)**: `server/` — Drizzle is the single canonical schema (`server/src/schema.ts`, re-exported to Deno via `_shared/db.ts`), migrations in `server/drizzle/`.
- **Viewer**: `app/` — Vue 3 + Vite + Tailwind. Analytics PostHog (EU) gated par consentement (`app/src/lib/analytics.ts` + `ConsentBanner`), identify par user Supabase. ⚠️ `api_host = location.origin + '/ingest'` → dépend de la **CF Pages Function reverse-proxy `app/functions/ingest/[[path]].ts`** (`/ingest/static/*`→assets PostHog, `/ingest/*`→ingestion) ; la retirer casse l'analytics en silence.
- **DB**: Postgres + `pgvector`.

## Layout

```
supabase/functions/   # mcp/index.ts (mem_* verbs) · api/index.ts (REST mirror) · _shared/
server/src/           # schema.ts (canonical) · migrate · seed · admin
server/drizzle/       # SQL migrations (+ meta)
app/src/              # viewer (views/, components/, lib/)
docs/                 # principles · specs · connect-mcp · access-control
```

## Commands

```bash
# schema
cd server && npm run db:generate     # gen migration from schema.ts (needs DATABASE_URL set — even a dummy; db.ts opens a client at import, no connection made)
npm run db:migrate                   # apply (needs DATABASE_URL)
npm run seed                         # demo workspace
npm run admin -- list                # admin CLI

# edge functions (local)
supabase functions serve

# viewer
cd app && npm run dev                # vite
npm run build                        # vue-tsc + vite build

# tests
cd supabase/functions && deno test --allow-env --allow-net --allow-read _shared/
```

## Conventions

- One canonical schema (`server/src/schema.ts`); enum/table changes go through a Drizzle migration. Migrating the DB must precede deploying functions that read new columns.
- The MCP surface is doctrine-first: `mem_doctrine` (map) before drilling; `mem_search` over enumeration. Writes never apply blind — `mem_stage_changes` → human review → `mem_apply_ingestion`; contradictions are never auto-applied.
- A block carries one sourceable claim; if it needs two, split it.
- Write verbs mutate the row **then** call `revise()` to log a `MemRevision` — **not atomic**. `revise()` backstops a missing `reason` (the column is `NOT NULL`), but any *other* failure after the mutation leaves the data changed while the op is reported "errored". Wrap mutation+revise in a transaction if you touch this path.
- `deno check` can't fully type-check `mcp/index.ts` locally (the MCP SDK's `.d.ts` is missing from Deno's cache) — check `_shared`/`api` locally, and rely on the deploy step's bundle type-check for `mcp`.
- **Write verbs are op-based**, one verb per domain dispatched by an `op` enum: content via `mem_stage_changes` (ops in `_shared/ingestion.ts`); structure via `mem_section_op`/`mem_move`/`mem_document_op` (+ `mem_reorder`); governance via `mem_workspace_admin`/`mem_grants`/`mem_org`. Adding a write capability = **a new `op` branch** (validate fields in-handler → explicit error; keep autz per-branch, never centralized), **not a new top-level tool** — the surface stays small so weak LLMs don't misfire (the whole point). Each verb is a thin shell over the unchanged `_shared/*` function; the REST mirror (`api/index.ts`) is a separate projection, untouched by MCP-surface changes. Make `op` optional with a sane default where it preserves back-compat for a client still on the old schema.
- **`INSTRUCTIONS` (the server preamble) is a backtick template literal** — NEVER put backticks in its body (e.g. around field names like docId): they close the template and break the bundle parse at deploy (no local catch — see the `deno check` note above). It is also served verbatim to every client → keep it **client-agnostic** (no "claude.ai"/"Claude"; say "the assistant"). The per-tool `description` strings are normal `"..."` strings — backticks are fine there.
- **Viewer layout**: `AppShell` (`.ed`) is `height:100%; overflow:hidden` — a page's scrollable body MUST be wrapped in `<div class="scroll">` (`.ed .scroll` = flex:1/min-height:0/overflow-y:auto), otherwise tall content is clipped with no scrollbar. Card/chrome styles live **globally** in `app/src/assets/editorial.css` under `.ed *` (views mostly carry no scoped styles) → a component extracted from a view inherits them as long as it renders inside `AppShell` (e.g. `IngestionReview`, the propose-validate review card shared by `LoopView` + `InboxView`).
- **Operational ids go in `payload`, never the descriptive `target` label** (the #1 staging footgun) — `add_document`→`payload.sectionId`, `add_block`→`documentId`, block ops→`id`, etc. (`TARGET` map in `_shared/ingestion.ts`). `add_document` also accepts a readable `payload.sectionPath`, resolved to `sectionId` at stage **and** apply (`resolvePathTargets` → `resolveSectionIdInWorkspace`, workspace-scoped).

## Edge Function secrets

Set as platform secrets (never committed — repo is public; read via `Deno.env.get`):

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — provisioning + GoTrue invite/magic-link generation.
- `MEMENTO_APP_URL` — app base for invite redirects + viewer links (`me.mento.cc`).
- `MEMENTO_PROVISION_BEARER` — shared secret guarding `POST /federation/provision` (oto→memento).
- `RESEND_API_KEY`, `MEMENTO_EMAIL_FROM` — transactional email (invitations). Memento generates the GoTrue action link without sending, then emails it itself via Resend (`_shared/email/`). Absent/failing ⇒ graceful fallback to a copyable invite link in the admin UI.
