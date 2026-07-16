# Memento — dev orientation

Knowledge substrate for agents, consumed via **MCP**. Typed blocks, sourced and linked,
maintained by a propose-validate loop. See [`docs/principles.md`](docs/principles.md) for the why
and [`docs/specs/knowledge-base.md`](docs/specs/knowledge-base.md) for the model + MCP surface.

## Méthode de travail

**Réponses** — courtes, droit au but, minimum de mots. Pas de récap de ce que l'user vient
de dire, pas de "voici ce que j'ai fait", pas de tableaux/emojis décoratifs. Résultat seulement.

**Avant de coder** —
- **Surfacer les hypothèses, pas trancher en silence.** Demande ambiguë → nommer le doute,
  proposer les options, demander.
- **Edits chirurgicaux.** Chaque ligne tracée à la demande. Pas de cleanup adjacent ni de
  refacto non demandé. Dead code repéré = mentionné, pas supprimé.
- **Critères de succès vérifiables d'abord** : reformuler la tâche en checks concrets
  (test qui reproduit le bug, `deno test` vert, `typecheck` propre) avant d'implémenter.
- **Push back quand justifié** : approche plus simple ou dette évidente → le dire avant d'exécuter.
- **Invariant d'archi touché → ADR** dans `docs/adr/` (suite 0001-0004), jamais en silence.
- ⚠️ **Repo public** : anonymiser vaut pour TOUT commit/PR/exemple, pas seulement les ADR/tests.

## V3 — refonte page-centrée (**LIVE en prod depuis le 2026-06-28**, cutover #58)

Pivot majeur (ADR dans `docs/adr/`, suite 0001–0004) : **suppression des blocs et liens typés** → une page = prose pure (titre+description+corps), un arbre ; **entités** = objet de 1er ordre niveau org (NER serveur + logique/décision) ; **1 base/org** ; accès par page ; **8 verbes MCP** (`server/src/mcp-contract.v3.ts`).

**Topologie post-cutover (consolidation in-project, runbook = issue #58 ; v3 promu en `main` le 2026-07-16)** : v3 vit dans le **schéma PG dédié `memento_v3`** du projet Supabase de mento.cc (auth partagée avec ex-v2, c'était tout l'enjeu). **v2 est RETIRÉ** — code viewer + edge supprimés, schéma `public` (tables métier) vidé ; les extensions partagées (`vector`/`unaccent`/`pgcrypto` + FTS `french_unaccent`) vivent dans le schéma **`extensions`**. Prod = app **me.mento.cc** + connecteur **mcp.mento.cc** (CF Pages `memento-viewer` : SPA + Pages Functions `app/functions/` qui proxifient `/mcp`→`functions/v1/mcp/mcp`, `/api`→`functions/v1/api`, `/.well-known`→`functions/v1/mcp`). **Fonctions edge = `mcp` + `api`** (les slugs `-v3` ont été renommés au cutover main ; l'URL publique du connecteur dérive de `MEMENTO_PUBLIC_URL`, pas du slug). **Viewer à la racine, sans `/v3`** : `/pages`, `/page/:id`, `/search`, `/inbox`, `/org`, `/connector`, `/entity/:id` (anciens `/v3/*` → redirections). Une page `public` est **lisible en anonyme** par lien (API GET sans Bearer → `sub=""`, scope public seul).

- ⚠️ **`db.v3.ts`, jamais `db.ts`, dans le graphe v3** : `_shared/db.v3.ts` pose `search_path=memento_v3,public,extensions` (tables v3 dans `memento_v3`, extensions + FTS dans `extensions`, `public` vide). Un module v3 qui importerait `db.ts` (défaut `public`) ne verrait **aucune table**.
- **Migrations v3 = `supabase/migrations/`**, appliquées **à la main, transformées** vers `memento_v3` (3 règles : prepend `search_path`, functions `SET search_path`, FK `"public"."mem_`→`"memento_v3"."mem_`) — cf. #58. Jamais auto-appliquées par la CI. (La lignée v2 `server/drizzle/` reste pour le typecheck/outillage Node ; les workflows de deploy v2 ont été **supprimés** au cutover main.)
- **Tester un lot v3 DB-backed** : conteneur pgvector jetable + appliquer `supabase/migrations/*.sql` (psql) + `deno test … --config supabase/functions/deno.json` avec `DATABASE_URL` posé. Les modules `*.v3.ts` chargent **sans** `DATABASE_URL` (db lazy `getDb()`) → unit/mock sans DB ; les tests vraiment DB-backed s'auto-skip sinon.
- **NER** = micro-service Python séparé (GLiNER, 3 types personne/entreprise/outil), `https://memento-ner.oto.zone`, bearer ; appelé **async** par `apply` (non bloquant). **Embeddings** = Mistral `mistral-embed` (1024), env `MEMENTO_MISTRAL_API_KEY`. **Indexation** chunk+embed dans l'apply (`_shared/indexing.v3.ts`).
- **`main` = la prod** (v3 promu le 2026-07-16, ex-branche `memento-v3` mergée) : un push sur `main` déploie (deploy-app/functions/ner). Plus de branche v3 séparée.
- ⚠️ **Repo PUBLIC** : pas de noms clients/personnes dans ADR/tests/exemples (anonymiser).

## Project context

- **Open-core**: this repo is the canonical, **public** (Apache-2.0) home — development happens in the open. The pre-open-core private history is archived at `otomata-tech/memento-legacy`.
- **How it's consumed**: an MCP connector (`mem_*` verbs, OAuth at `https://mcp.mento.cc/mcp`, doctrine-first) wired into claude.ai / ChatGPT / Mistral Le Chat.
- **Companion**: `otomata-tech/memento-plugin` — Claude Code skills (`/memento:*`) for session-learning capture and propose-validate pushes to the KB.
- Detailed prod deployment topology is operator-internal and lives outside this public doc.
- **Mainteneurs** : Alexis & JB — 2 devs sur le repo ; coordonner avant un changement transverse (schéma, surface MCP, cutover v3).


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

## CI & avant de pusher

Pas de lint serveur. Checks locaux avant push :
- `cd supabase/functions && deno test --allow-env --allow-net --allow-read _shared/` (rejoués par `test.yml` sur PR + push `main`)
- `cd server && npm run typecheck`
- `cd app && npm run build` (vue-tsc — seule vérif TS du viewer)

**Un push sur `main` déclenche des déploiements selon les paths** (tous gated `repository_owner == otomata-tech` → un fork ne déploie pas la prod) :

| Paths | Workflow | Effet |
|---|---|---|
| `supabase/functions/**` | `deploy-functions` | deploy `api`+`mcp` → **projet Supabase de PROD** — **AUCUNE migration DB** |
| `app/**` | `deploy-app` | build + deploy **CF Pages `memento-viewer` = PROD** me.mento.cc/mcp.mento.cc |
| `ner/**` | `deploy-ner` | SSH box NER → redeploy GLiNER |
| `supabase/**`, `server/**` (push `main` + PR) | `test` | deno test `_shared/*.test.ts` sur Postgres pgvector (provisionne `memento_v3`, strippe pg_cron) |

⚠️ **Un push `main` déploie LA PROD** (plus de staging ni de branche v3 séparée depuis
le cutover main du 2026-07-16). Les migrations v3 (`supabase/migrations/`) ne sont **jamais**
auto-appliquées — manuel, transformées vers `memento_v3` (cf. § V3).

**Gate local en une commande** — `bash scripts/test-local.sh` rejoue tout le filet avant un push
(DB locale migrée v3 via `supabase db reset` → `deno test _shared/` DB-backed → typecheck server →
build app). Prérequis one-shot (Docker lancé + Deno + Supabase CLI dans le PATH) : installeurs par
OS en tête du script.

## Conventions

- One canonical schema (`server/src/schema.ts`); enum/table changes go through a Drizzle migration. Migrating the DB must precede deploying functions that read new columns.
- The MCP surface is doctrine-first: `mem_doctrine` (map) before drilling; `mem_search` over enumeration. Writes never apply blind — `mem_stage_changes` → human review → `mem_apply_ingestion`; contradictions are never auto-applied.
- A block carries one sourceable claim; if it needs two, split it.
- Write verbs mutate the row **then** call `revise()` to log a `MemRevision` — **not atomic**. `revise()` backstops a missing `reason` (the column is `NOT NULL`), but any *other* failure after the mutation leaves the data changed while the op is reported "errored". Wrap mutation+revise in a transaction if you touch this path.
- `deno check` can't fully type-check `mcp/index.ts` locally (the MCP SDK's `.d.ts` is missing from Deno's cache) — check `_shared`/`api` locally, and rely on the deploy step's bundle type-check for `mcp`.
- **Write verbs are op-based**, one verb per domain dispatched by an `op` enum: content via `mem_stage_changes` (ops in `_shared/ingestion.ts`); structure via `mem_section_op`/`mem_move`/`mem_document_op` (+ `mem_reorder`); governance via `mem_workspace_admin`/`mem_grants`/`mem_org`. Adding a write capability = **a new `op` branch** (validate fields in-handler → explicit error; keep autz per-branch, never centralized), **not a new top-level tool** — the surface stays small so weak LLMs don't misfire (the whole point). Each verb is a thin shell over the unchanged `_shared/*` function; the REST mirror (`api/index.ts`) is a separate projection, untouched by MCP-surface changes. Make `op` optional with a sane default where it preserves back-compat for a client still on the old schema.
- **`INSTRUCTIONS` (the server preamble) is a backtick template literal** — NEVER put backticks in its body (e.g. around field names like docId): they close the template and break the bundle parse at deploy (no local catch — see the `deno check` note above). It is also served verbatim to every client → keep it **client-agnostic** (no "claude.ai"/"Claude"; say "the assistant"). The per-tool `description` strings are normal `"..."` strings — backticks are fine there.
- **Operational ids go in `payload`, never the descriptive `target` label** (the #1 staging footgun) — `add_document`→`payload.sectionId`, `add_block`→`documentId`, block ops→`id`, etc. (`TARGET` map in `_shared/ingestion.ts`). `add_document` also accepts a readable `payload.sectionPath`, resolved to `sectionId` at stage **and** apply (`resolvePathTargets` → `resolveSectionIdInWorkspace`, workspace-scoped).

## Edge Function secrets

Set as platform secrets (never committed — repo is public; read via `Deno.env.get`):

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — provisioning + GoTrue invite/magic-link generation.
- `MEMENTO_APP_URL` — app base for invite redirects + viewer links (`me.mento.cc`).
- `MEMENTO_PROVISION_BEARER` — shared secret guarding `POST /federation/provision` (oto→memento).
- `RESEND_API_KEY`, `MEMENTO_EMAIL_FROM` — transactional email (invitations). Memento generates the GoTrue action link without sending, then emails it itself via Resend (`_shared/email/`). Absent/failing ⇒ graceful fallback to a copyable invite link in the admin UI.

## Docs
- `principles.md` — le pourquoi (modèle page-centré, propose-valide, doctrine-first).
- `specs/knowledge-base.md` — spec fondatrice (modèle + surface MCP).
- `access-control.md` — modèle d'accès (visibilités par page, grants, héritage).
- `connect-mcp.md` — brancher le connecteur MCP (OAuth, clients).
- `deploy.md` — déployer la PROD (push `main`, garde-fous migrations).
- `deployment-edge.md` — topologie edge (CF Pages Functions ↔ Supabase functions, domaines, proxy).
- `adr/` — décisions d'architecture (0001–0004).
