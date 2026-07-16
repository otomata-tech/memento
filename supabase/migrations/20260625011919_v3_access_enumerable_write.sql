-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Memento V3 — accès : is_page_enumerable + autorité d'écriture (issue #61)   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Suite de #56 (e6baabe). Migration SÉPARÉE, append-only : on ne réécrit pas
-- `*_v3_fine_access.sql`. `supabase db reset` la rejoue après → ces CREATE OR
-- REPLACE supersèdent les définitions de #56.
--
-- 2 ajustements tranchés par le hub :
--  1. is_page_enumerable(page) = page_read_mode($1) IS NOT NULL = is_page_accessible
--     SANS le public-par-lien. Anti-fuite de noms (ADR 0003 : public = lien seul,
--     non listé/cherchable). is_page_accessible (public inclus) RESTE pour le
--     get-par-lien + la RLS de lecture. Le lot search (#57) cible ce prédicat.
--  2. page_read_mode : on RETIRE le fallback « membre ⇒ write ». Écriture =
--     owner OU grant(write) OU org_admin. Le membre simple LIT (et propose via
--     propose→apply), il n'écrit pas le canon directement.

-- ── page_read_mode (redéfini) ─────────────────────────────────────────────────
-- Inchangé vs #56 SAUF le fallback de fin de chaîne (chaîne entièrement héritée,
-- aucun gate explicite) : org_admin ⇒ 'write', membre ⇒ 'read' (et non plus
-- 'write'), sinon NULL. Les décisions locales (owner/grant/private) sont
-- identiques ; l'org_admin ne franchit PAS un gate `private` d'autrui (private
-- reste personnel : gouvernance ≠ accès au contenu privé).
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
  dec AS ( -- décision LOCALE : write|read|none (=bloqué) | NULL (=hérite)
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
    WHEN (SELECT d FROM nearest) IS NOT NULL THEN nullif((SELECT d FROM nearest), 'none')
    -- chaîne entièrement héritée (org/public sans gate) : org_admin écrit le canon,
    -- le membre simple lit (propose→apply pour contribuer), sinon pas d'accès.
    WHEN EXISTS (
      SELECT 1 FROM mem_memberships m JOIN mem_bases b ON b.org_id = m.org_id
      WHERE m.user_id = mem_current_sub() AND b.id = (SELECT base_id FROM chain LIMIT 1)
        AND m.role = 'admin'
    ) THEN 'write'
    WHEN EXISTS (
      SELECT 1 FROM mem_memberships m JOIN mem_bases b ON b.org_id = m.org_id
      WHERE m.user_id = mem_current_sub() AND b.id = (SELECT base_id FROM chain LIMIT 1)
    ) THEN 'read'
    ELSE NULL
  END;
$$;

-- ── is_page_enumerable : prédicat d'ÉNUMÉRATION (search/list) ──────────────────
-- = accessible via membership/grant/owner/héritage, MAIS PAS le public-par-lien
-- d'une autre org → anti-fuite (public non listé/cherchable). À utiliser dans le
-- WHERE de search (#57). is_page_accessible (public inclus) reste pour get/RLS.
CREATE OR REPLACE FUNCTION is_page_enumerable(p_page uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT page_read_mode(p_page) IS NOT NULL
$$;
