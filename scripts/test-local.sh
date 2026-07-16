#!/usr/bin/env bash
#
# test-local.sh — rejoue EN LOCAL le gate avant un push.
#
# Pourquoi : un push sur `memento-v3` déclenche jusqu'à 3 self-service deploys
# (functions-v3, app, NER) et ne lance AUCUN test (test.yml ne tourne que sur
# push `main` + PR). Ce script est donc le filet avant un push direct.
#
# Couvre, dans l'ordre fail-fast :
#   1. DB locale Postgres+pgvector migrée v3   (supabase start + db reset → :54322)
#   2. Tests Edge Functions DB-backed          (deno test _shared/, parité test.yml)
#   3. Typecheck du schéma/outillage Node       (server)
#   4. Build du viewer (vue-tsc + vite)         (app)
#
# Prérequis (one-shot) : Docker lancé + Deno + Supabase CLI dans le PATH.
#   macOS/Linux : brew install deno supabase/tap/supabase   (+ Docker ou Colima)
#   Windows     : winget install DenoLand.Deno ; scoop install supabase ; winget install Docker.DockerDesktop
#               (la CLI Supabase n'est PAS sur winget → Scoop)
#
# Usage :  bash scripts/test-local.sh
#   (depuis PowerShell sur Windows : passe par Git Bash → `bash scripts/test-local.sh`)
#
# Note : `supabase db reset` est DESTRUCTIF pour la DB LOCALE (jamais la prod) —
#        il rejoue supabase/migrations/* (lignée v3), pas server/drizzle/ (v2).

set -euo pipefail

cd "$(dirname "$0")/.."  # racine du repo, quel que soit le cwd d'appel

DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
export DATABASE_URL

# Scope = les tests v3 : ce script provisionne le schéma v3 (`supabase db reset`),
# donc les tests v2 (load/onboarding) casseraient contre lui — ils vivent dans le job
# v2 de la CI. Non quoté → le shell développe le glob (dans supabase/functions). On
# n'inclut pas mcp/*.test.ts (SDK MCP .d.ts absent du cache Deno local, cf. CLAUDE.md) :
# c'est le même périmètre que le job v3-integration de test.yml.
DENO_TEST_PATH="${DENO_TEST_PATH:-_shared/*.v3.test.ts}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ '$1' introuvable dans le PATH — voir les prérequis en tête de ce script."; exit 1; }; }
need supabase; need deno; need npm; need docker

echo "== 1/4 · DB locale Supabase (Postgres+pgvector, migrations v3) =="
supabase start                 # idempotent ; 1re fois = pull des images Docker (long)
supabase db reset              # rejoue supabase/migrations/* sur la DB locale

echo "== 2/4 · Tests Edge Functions (deno, DB-backed) =="
(
  cd supabase/functions
  deno test --allow-env --allow-net --allow-read $DENO_TEST_PATH
)

echo "== 3/4 · Typecheck Node (schéma Drizzle + outillage) =="
(
  cd server
  [ -d node_modules ] || npm ci
  npm run typecheck
)

echo "== 4/4 · Build du viewer (vue-tsc + vite) =="
(
  cd app
  [ -d node_modules ] || npm ci
  npm run build
)

echo
echo "✓ Tous les checks locaux passent — safe to push."
