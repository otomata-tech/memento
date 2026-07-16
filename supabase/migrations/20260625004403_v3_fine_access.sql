-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Memento V3 — accès par page : prédicat unique + RLS fine (issue #56)        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Remplace le PLACEHOLDER posé par la migration v3 (#53) : les stubs
-- accessible_base_ids()/accessible_page_ids() renvoyaient le vide et la seule
-- policy ne laissait passer que `public`. Migration SÉPARÉE, append-only : on ne
-- réécrit pas le fichier #53 committé ; `supabase db reset` la rejoue après #53.
--
-- MODÈLE (ADR 0003 §2/§4) :
--   3 visibilités par page : private (proprio + invités) · org (membres) · public
--   (tous, mais PAR LIEN SEUL : non listé/non cherchable par les non-membres).
--   + grants par user (mem_page_grants, mode read|write).
--   HÉRITAGE : le plus proche ancêtre EXPLICITE gagne ; une page org/public sous
--   un ancêtre private reste derrière le gate (restriction descendante, jamais
--   d'élargissement) ; `public` n'est JAMAIS hérité.
--
-- SOURCE UNIQUE = `page_read_mode(page)` : le mode effectif null|read|write pour
-- l'utilisateur courant (mem_current_sub()), par REMONTÉE des ancêtres
-- (nearest-explicit-wins). TOUT en dérive — is_page_accessible, accessible_page_ids,
-- l'écriture, les policies RLS, le choke-point TS — zéro logique dupliquée.
--
-- Identité de l'appelant = `mem_current_sub()` (request.jwt.claims). Aucune
-- fonction ne prend d'argument `sub` : RLS la lit du JWT ; le runtime (qui
-- contourne la RLS en propriétaire) la POSE via set_config avant ses checks
-- (cf. withCurrentSub dans access.v3.ts). SECURITY DEFINER : les helpers lisent
-- memberships/grants quel que soit le GRANT du rôle appelant.

-- ── page_read_mode : LE cœur. Mode effectif (null|read|write) de p_page pour ───
-- l'utilisateur courant. Remonte la chaîne d'ancêtres ; le 1er nœud « explicite »
-- (proprio / grant / private-sans-accès) au plus près gagne ; à défaut, un membre
-- de la base obtient 'write' (mémoire partagée), sinon NULL.
CREATE OR REPLACE FUNCTION page_read_mode(p_page uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH RECURSIVE chain AS (
    SELECT p.id, p.parent_id, p.base_id, p.visibility, p.owner_id, 0 AS lvl
      FROM mem_pages p WHERE p.id = p_page
    UNION ALL
    SELECT a.id, a.parent_id, a.base_id, a.visibility, a.owner_id, c.lvl + 1
      FROM mem_pages a JOIN chain c ON a.id = c.parent_id
  ),
  dec AS ( -- décision LOCALE de chaque nœud : write|read|none (=bloqué) | NULL (=hérite)
    SELECT c.lvl, c.base_id,
      CASE
        WHEN c.owner_id = mem_current_sub()           THEN 'write'
        WHEN gm.mode IS NOT NULL                       THEN gm.mode::text
        WHEN c.visibility = 'private'                  THEN 'none'
        ELSE NULL
      END AS d
    FROM chain c
    LEFT JOIN mem_page_grants gm ON gm.page_id = c.id AND gm.user_id = mem_current_sub()
  ),
  nearest AS ( SELECT d FROM dec WHERE d IS NOT NULL ORDER BY lvl LIMIT 1 )
  SELECT CASE
    -- un ancêtre explicite a tranché : 'none' (gate private fermé) → pas d'accès.
    WHEN (SELECT d FROM nearest) IS NOT NULL THEN nullif((SELECT d FROM nearest), 'none')
    -- chaîne entièrement « héritée » (org/public sans gate) → membre = write.
    WHEN EXISTS (
      SELECT 1 FROM mem_memberships m
        JOIN mem_bases b ON b.org_id = m.org_id
      WHERE m.user_id = mem_current_sub()
        AND b.id = (SELECT base_id FROM chain LIMIT 1)
    ) THEN 'write'
    ELSE NULL
  END;
$$;

-- is_page_accessible : LE prédicat de LECTURE. Vrai ssi public (lien) OU accès
-- effectif (base/grant/héritage). UTILISÉ DANS LA POLICY RLS de mem_pages ET
-- exposé pour le WHERE de `search` → un seul endroit, zéro drift policy↔search.
CREATE OR REPLACE FUNCTION is_page_accessible(p_page uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT visibility = 'public' FROM mem_pages WHERE id = p_page), false)
      OR page_read_mode(p_page) IS NOT NULL
$$;

-- page_can_write : autorité d'écriture sur p_page (mode effectif = write).
CREATE OR REPLACE FUNCTION page_can_write(p_page uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT page_read_mode(p_page) = 'write'
$$;

-- accessible_page_ids : l'ensemble ÉNUMÉRABLE (lecture) — remplace le stub #53.
-- NO-ARG (lit mem_current_sub()). EXCLUT les pages `public` d'autres orgs (lien
-- seul, jamais listées) : on n'énumère que ce qui a un mode effectif.
CREATE OR REPLACE FUNCTION accessible_page_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM mem_pages WHERE page_read_mode(id) IS NOT NULL
$$;

-- accessible_base_ids : bases dont l'user courant est membre (1 base/org).
CREATE OR REPLACE FUNCTION accessible_base_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.id FROM mem_bases b
    JOIN mem_memberships m ON m.org_id = b.org_id AND m.user_id = mem_current_sub()
$$;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ RLS fine — remplace la policy placeholder. Filet DB (le runtime, en         ║
-- ║ propriétaire, CONTOURNE la RLS ; le choke-point TS assertAccess est le fin).║
-- ║ SELECT only : la Data API n'a aucun client en écriture (posture v2).        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
DROP POLICY IF EXISTS "mem_pages_read_placeholder" ON "mem_pages";

-- LE même prédicat que `search` → aucune divergence possible.
CREATE POLICY "mem_pages_read" ON "mem_pages" FOR SELECT
  USING ( is_page_accessible("id") );

-- Contenus rattachés à une page : visibles ssi la page est énumérable.
CREATE POLICY "mem_page_chunks_read" ON "mem_page_chunks" FOR SELECT
  USING ( "page_id" IN (SELECT accessible_page_ids()) );
CREATE POLICY "mem_page_sources_read" ON "mem_page_sources" FOR SELECT
  USING ( "page_id" IN (SELECT accessible_page_ids()) );
CREATE POLICY "mem_mentions_read" ON "mem_mentions" FOR SELECT
  USING ( "page_id" IN (SELECT accessible_page_ids()) );

-- Sources / ingestions / révisions : portée base (membre de l'org).
CREATE POLICY "mem_sources_read" ON "mem_sources" FOR SELECT
  USING ( "base_id" IN (SELECT accessible_base_ids()) );
CREATE POLICY "mem_ingestions_read" ON "mem_ingestions" FOR SELECT
  USING ( "base_id" IN (SELECT accessible_base_ids()) );
CREATE POLICY "mem_revisions_read" ON "mem_revisions" FOR SELECT
  USING ( "base_id" IN (SELECT accessible_base_ids()) );

-- Entités / revue : niveau ORG (ADR 0002) — visibles aux membres de l'org.
CREATE POLICY "mem_entities_read" ON "mem_entities" FOR SELECT
  USING ( "org_id" IN (SELECT b.org_id FROM mem_bases b WHERE b.id IN (SELECT accessible_base_ids())) );
CREATE POLICY "mem_entity_reviews_read" ON "mem_entity_reviews" FOR SELECT
  USING ( "org_id" IN (SELECT b.org_id FROM mem_bases b WHERE b.id IN (SELECT accessible_base_ids())) );

-- Grants : l'user voit les siens + ceux des pages auxquelles il a accès.
CREATE POLICY "mem_page_grants_read" ON "mem_page_grants" FOR SELECT
  USING ( "user_id" = mem_current_sub() OR "page_id" IN (SELECT accessible_page_ids()) );

-- mem_orgs / mem_memberships / mem_bases : restent en deny-all (aucune policy) —
-- tables tenant, jamais lues via la Data API ; le runtime les lit en bypass RLS.
