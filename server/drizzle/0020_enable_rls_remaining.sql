-- Active RLS sur les deux tables ajoutées après 0005/0013 sans `ENABLE ROW
-- LEVEL SECURITY` (advisor Supabase `rls_disabled_in_public`, alerte du 22/06) :
--   • mem_pinned_workspaces (épingles KB publiques, lue/écrite via _shared/prefs.ts)
--   • mem_agent_chat_log    (journal du mode agent, écrit/listé via _shared/agent_log.ts)
-- Le schéma `public` est exposé par PostgREST (Data API) aux rôles `anon`/
-- `authenticated` via la clé anon publique du front : sans RLS, ces deux tables
-- étaient lisibles/modifiables/supprimables par quiconque a l'URL projet. Aucune
-- des deux n'est touchée par le front en direct — seulement par les Edge Functions
-- (rôle propriétaire, qui CONTOURNE la RLS, pas de FORCE). Donc, comme 0005/0013 :
-- RLS activée + AUCUNE policy = deny-all pour anon/authenticated, accès serveur intact.
ALTER TABLE "mem_pinned_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mem_agent_chat_log" ENABLE ROW LEVEL SECURITY;
