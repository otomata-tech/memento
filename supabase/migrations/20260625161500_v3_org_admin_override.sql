-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Memento V3 — override org_admin sur l'accès par page (fix lockout `private`) ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- BUG (remonté par test) : `share {visibility:'private'}` était une TRAPPE À SENS
-- UNIQUE. `private` = proprio + invités ; un org_admin qui privatise une page
-- qu'il ne POSSÈDE pas perd aussitôt l'accès (get/share) et ne peut plus l'annuler.
-- Aggravé par la migration v2→v3 : TOUTES les pages migrées ont pour owner le sub
-- de migration (une identité de service, personne ne s'y connecte) → n'importe
-- quelle page privatisée deviendrait DÉFINITIVEMENT injoignable.
--
-- FIX (RBAC, aligné ADR 0025 `platform_admin ⊇ org_admin ⊇ member`) : un admin de
-- l'org propriétaire de la base a un accès EFFECTIF 'write' sur TOUTE page de l'org,
-- quelle que soit sa visibilité — il peut donc toujours dé-privatiser. `private`
-- garde son sens vis-à-vis des MEMBRES non-admin (caché) ; l'admin de l'org, lui,
-- gouverne (cohérent avec `assertCanSetVisibility` qui réserve déjà PUBLIER à
-- owner|org_admin). Le geste reste tracé/confirmé côté verbe (isSensitivePublication).
--
-- Append-only : redéfinit `page_read_mode` (la SOURCE UNIQUE) → is_page_accessible,
-- accessible_page_ids, page_can_write, les policies RLS et le choke-point TS en
-- héritent sans duplication. `supabase db reset` la rejoue après #56.

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
    -- (NOUVEAU) admin de l'org propriétaire = accès plein 'write' sur toute page de
    -- l'org, PRIORITAIRE sur le gate private → pas d'auto-lockout, gouvernance org.
    WHEN EXISTS (
      SELECT 1 FROM mem_bases b
        JOIN mem_memberships m ON m.org_id = b.org_id AND m.user_id = mem_current_sub()
      WHERE b.id = (SELECT base_id FROM chain LIMIT 1) AND m.role = 'admin'
    ) THEN 'write'
    -- un ancêtre explicite a tranché : 'none' (gate private fermé) → pas d'accès.
    WHEN (SELECT d FROM nearest) IS NOT NULL THEN nullif((SELECT d FROM nearest), 'none')
    -- chaîne entièrement « héritée » (org/public sans gate) → membre simple = READ
    -- (write réservé owner/grant/org_admin — #61 ; l'admin est déjà capté plus haut).
    WHEN EXISTS (
      SELECT 1 FROM mem_memberships m
        JOIN mem_bases b ON b.org_id = m.org_id
      WHERE m.user_id = mem_current_sub()
        AND b.id = (SELECT base_id FROM chain LIMIT 1)
    ) THEN 'read'
    ELSE NULL
  END;
$$;
