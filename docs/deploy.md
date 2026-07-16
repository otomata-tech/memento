---
title: Déployer (prod)
type: how-to
description: >-
  Comment déployer Memento en production (me.mento.cc / mcp.mento.cc) : push sur
  main = déploiement auto par filtres de chemin (app → CF Pages memento-viewer,
  functions → projet Supabase de prod, ner → box GLiNER). Garde-fous : migrations
  v3 manuelles transformées vers le schéma memento_v3.
adr: [0001, 0002, 0003]
---

# Déployer (prod)

**`main` déploie LA PROD** — me.mento.cc (app) et mcp.mento.cc (connecteur MCP).
Il n'y a **pas de staging** (v3 promu en `main` le 2026-07-16 ; l'ex-branche
`memento-v3` et l'ancien projet Supabase blue-green sont décommissionnés). Le
déploiement est **automatique au push** : pas d'accès serveur ni de secret à
manipuler, tout passe par GitHub Actions.

## Déployer

Pousser sur `main` suffit. Selon ce que le commit touche, le bon workflow se
déclenche (filtres de chemin) :

| Tu changes…                 | Workflow déclenché       | Cible                                                     |
| --------------------------- | ------------------------ | --------------------------------------------------------- |
| `app/**`                    | **Deploy app**           | build → **CF Pages `memento-viewer`** = me.mento.cc / mcp.mento.cc |
| `supabase/functions/**`     | **Deploy edge functions**| `api` + `mcp` sur le **projet Supabase de prod** (celui de mento.cc) |
| `ner/**`                    | **Deploy NER**           | micro-service GLiNER → box dédiée `memento-ner`            |
| `supabase/**` · `server/**` | **Tests** (push + PR)    | deno test `_shared/` sur Postgres pgvector (ne déploie rien) |
| autre (`docs/`…)            | aucun                    | rien n'est déployé                                         |

```bash
git pull --rebase --autostash   # la prod = ce qui est sur main
# … commits …
bash scripts/test-local.sh      # filet local (la CI Tests rejoue _shared/ sur push/PR)
git pull --rebase --autostash && git push   # → le(s) déploiement(s) prod partent tout seuls
```

**Re-déploiement manuel** (sans nouveau commit) : onglet **Actions** → choisir le
workflow → **Run workflow** sur `main`.

## Vérifier

Onglet **Actions** : suivre le run. Vert = déployé. Puis smoke rapide :
`https://me.mento.cc/` (200), une page publique `https://me.mento.cc/page/<id>`
(s'ouvre sans compte), et le connecteur répond sur
`https://mcp.mento.cc/.well-known/oauth-protected-resource` (JSON, pas du HTML).

## Garde-fous

- **C'est la prod.** Pas de push exploratoire ; `bash scripts/test-local.sh` d'abord.
- **Migrations DB v3 : jamais via la CI.** Les tables v3 vivent dans le **schéma
  `memento_v3`** du projet de prod (v2 retiré ; extensions dans `extensions`).
  Une migration `supabase/migrations/*.sql` s'applique **à la main, transformée**
  (search_path + FK vers `memento_v3` — procédure dans l'issue #58). Un changement
  de schéma déployé sans sa migration casse les functions : signale-le avant de pousser.
- **Graphe v3 = `db.v3.ts`**, jamais `db.ts` (défaut `public`).
- **Renommer une fonction Supabase** (slug) : déployer en 2 temps (fonction puis
  proxy `app/functions/`) pour ne pas casser le connecteur — cf. [`deployment-edge.md`](deployment-edge.md).
- Le projet est **public** (open-core) : ne commite jamais de secret ni de nom client.
