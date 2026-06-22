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

## Edge Function secrets

Set as platform secrets (never committed — repo is public; read via `Deno.env.get`):

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — provisioning + GoTrue invite/magic-link generation.
- `MEMENTO_APP_URL` — app base for invite redirects + viewer links (`me.mento.cc`).
- `MEMENTO_PROVISION_BEARER` — shared secret guarding `POST /federation/provision` (oto→memento).
- `RESEND_API_KEY`, `MEMENTO_EMAIL_FROM` — transactional email (invitations). Memento generates the GoTrue action link without sending, then emails it itself via Resend (`_shared/email/`). Absent/failing ⇒ graceful fallback to a copyable invite link in the admin UI.
