---
title: Déployer sur staging (V3)
audience: contributeurs (déploiement autonome staging)
scope: branche memento-v3 → memento-v3.oto.zone
---

# Déployer sur staging (V3)

**Staging = la V3**, branche `memento-v3` → `https://memento-v3.oto.zone`.
Le déploiement est **automatique au push** : pas d'accès serveur ni de secret à
manipuler, tout passe par GitHub Actions.

## Déployer

Pousser sur `memento-v3` suffit. Selon ce que le commit touche, le bon workflow
se déclenche (filtres de chemin) :

| Tu changes…                 | Workflow déclenché          | Cible                                  |
| --------------------------- | --------------------------- | -------------------------------------- |
| `app/**`                    | **Deploy app (v3)**         | SPA → otomata-0, servie par Caddy      |
| `supabase/functions/**`     | **Deploy edge functions (v3)** | Edge Functions du projet Supabase v3 |
| `ner/**`                    | **Deploy NER (v3)**         | micro-service GLiNER → box dédiée `memento-ner` |
| autre (`docs/`, `server/`…) | aucun                       | rien n'est déployé                     |

```bash
git switch memento-v3
git pull
# … commits …
git push            # → le(s) déploiement(s) partent tout seuls
```

**Re-déploiement manuel** (sans nouveau commit) : onglet **Actions** → choisir
*Deploy app (v3)* ou *Deploy edge functions (v3)* → **Run workflow** sur
`memento-v3`. Utile pour rejouer un déploiement.

## Vérifier

Onglet **Actions** : suivre le run. Vert = déployé. *Deploy app (v3)* fait un
smoke test en fin de course et **rollback automatiquement** sur l'ancien build si
le smoke échoue — un run rouge laisse donc staging dans son état précédent.

## Garde-fous

- **Ne pousse pas `main`.** `main` = **prod** (mento.cc) ; le push y est **restreint**
  (réservé à Alexis) — la prod reste verrouillée pour le moment.
- **Migrations DB : pas via la CI.** Les migrations du schéma v3 sont **appliquées
  à la main** par un opérateur (elles sont sensibles). Un changement de schéma
  (`server/drizzle/`) déployé sans sa migration appliquée casse les functions.
  Si ton changement suppose une migration, signale-le avant de pousser.
- Le projet est **public** (open-core) : ne commite jamais de secret.
