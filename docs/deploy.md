---
title: Déployer (V3 — prod)
type: how-to
description: >-
  Comment déployer Memento V3 en production (me.mento.cc / mcp.mento.cc) : push sur
  memento-v3 = déploiement auto par filtres de chemin (app → CF Pages memento-viewer,
  functions → projet Supabase de prod, ner → box GLiNER). Garde-fous post-cutover #58 :
  migrations v3 manuelles transformées vers le schéma memento_v3, workflow main/app désactivé.
adr: [0001, 0002, 0003]
---

# Déployer (V3 — prod)

**⚠️ Depuis le cutover du 2026-06-28 (issue #58), `memento-v3` déploie LA PROD** —
me.mento.cc (app) et mcp.mento.cc (connecteur MCP). Il n'y a **plus de staging**
(memento-v3.oto.zone et l'ancien projet Supabase blue-green sont décommissionnés).
Le déploiement est **automatique au push** : pas d'accès serveur ni de secret à
manipuler, tout passe par GitHub Actions.

## Déployer

Pousser sur `memento-v3` suffit. Selon ce que le commit touche, le bon workflow
se déclenche (filtres de chemin) :

| Tu changes…                 | Workflow déclenché             | Cible                                                     |
| --------------------------- | ------------------------------ | --------------------------------------------------------- |
| `app/**`                    | **Deploy app (v3)**            | build (`VITE_MEMENTO_V3=true`) → **CF Pages `memento-viewer`** = me.mento.cc / mcp.mento.cc |
| `supabase/functions/**`     | **Deploy edge functions (v3)** | `api-v3` + `mcp-v3` sur le **projet Supabase de prod** (celui de mento.cc) |
| `ner/**`                    | **Deploy NER (v3)**            | micro-service GLiNER → box dédiée `memento-ner`            |
| autre (`docs/`, `server/`…) | aucun                          | rien n'est déployé                                         |

```bash
git switch memento-v3
git pull            # OBLIGATOIRE avant de travailler (la prod = ce qui est sur la branche)
# … commits …
bash scripts/test-local.sh   # le filet local (aucun test côté CI sur cette branche)
git push            # → le(s) déploiement(s) prod partent tout seuls
```

**Re-déploiement manuel** (sans nouveau commit) : onglet **Actions** → choisir
le workflow → **Run workflow** sur `memento-v3`.

## Vérifier

Onglet **Actions** : suivre le run. Vert = déployé. Puis smoke rapide :
`https://me.mento.cc/` (200), et le connecteur répond sur
`https://mcp.mento.cc/.well-known/oauth-protected-resource` (JSON, pas du HTML).

## Garde-fous

- **C'est la prod.** Pas de push exploratoire ; `bash scripts/test-local.sh` d'abord.
- **Migrations DB v3 : jamais via la CI.** Les tables v3 vivent dans le **schéma
  `memento_v3`** du projet de prod (v2 retiré, `public` vide ; extensions dans `extensions`).
  Une migration `supabase/migrations/*.sql` s'applique **à la main, transformée**
  (search_path + FK vers `memento_v3` — procédure dans l'issue #58). Un changement
  de schéma déployé sans sa migration casse les functions : signale-le avant de pousser.
- **Graphe v3 = `db.v3.ts`**, jamais `db.ts` (défaut `public`, désormais vide).
- **Ne réactive pas « Deploy viewer to Cloudflare Pages »** (workflow `main`,
  désactivé) : il écraserait le front v3 (même projet CF Pages).
- Le projet est **public** (open-core) : ne commite jamais de secret ni de nom client.
