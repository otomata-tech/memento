-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Memento V3 — rate limiting applicatif : table manquée par le cutover v3   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- BUG (2026-07-02) : tout verbe rate-limité (create_org, invitations…) échouait
-- en prod v3 — `_shared/ratelimit.ts` upserte dans `mem_rate_limits`, or la table
-- n'existait DANS AUCUN schéma : elle vient de la lignée v2 (`server/drizzle/
-- 0013_rate_limits.sql` + `0014_pg_cron_purge.sql`, issue #67), désactivée au
-- cutover v3, et n'avait jamais été portée dans CETTE lignée. Le limiter plante
-- alors AVANT le verbe (« relation does not exist ») → create_org 100 % cassé.
-- Reprise du DDL 0013/0014, transformé v3 (search_path + purge schéma-qualifiée).
set search_path to memento_v3;

-- Compteur à fenêtre fixe par (identité, bucket, fenêtre) — upsert-incrément
-- atomique en SQL brut depuis _shared/ratelimit.ts, hors schéma Drizzle.
-- RLS deny-all ; le rôle propriétaire (Edge Functions) bypasse.
CREATE TABLE IF NOT EXISTS mem_rate_limits (
    sub TEXT NOT NULL,
    bucket TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (sub, bucket, window_start)
);

CREATE INDEX IF NOT EXISTS mem_rate_limits_window ON mem_rate_limits (window_start);
ALTER TABLE mem_rate_limits ENABLE ROW LEVEL SECURITY;

-- Purge quotidienne des fenêtres périmées (reprise 0014). pg_cron = Supabase ;
-- corps du job SCHÉMA-QUALIFIÉ (le job tourne hors search_path de session).
-- cron.schedule(name, …) est un upsert par nom → idempotent.
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'memento-v3-purge-rate-limits',
  '0 3 * * *',
  $$DELETE FROM memento_v3.mem_rate_limits WHERE window_start < now() - interval '1 day'$$
);
