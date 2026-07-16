# memento-ner

Micro-service d'extraction d'entités **NER** pour Memento (ADR 0002). Seule brique
Python de la stack ; le reste du backend reste Deno/Supabase. Tourne sur `otomata-0`.

- **Modèle** : GLiNER `urchade/gliner_multi-v2.1` (zero-shot typé, **pas un LLM**, CPU ~100 ms/page).
- **Types** : `personne · entreprise · outil` (3 verrouillés — ADR 0002). Élargir = sur preuve d'usage.
- **Périmètre** : extraction seule. La **résolution** (normalise → exact-match → trigram + Jaro-Winkler →
  seuil → revue/adjudicateur) reste **côté Deno/Postgres**. Source unique de la normalisation = la fn SQL
  `normalise_name`. Le service ne renvoie donc **pas** de clé normalisée (anti-divergence).
- Les **entités logiques** (décision…) sont posées par l'agent via `propose_changes`, pas par ce service.

## Contrat HTTP

```
GET  /health                            -> {status, model, types}
POST /extract        {text, threshold?} -> {entities: [{text,type,score,start,end}]}
POST /extract_batch  {texts, threshold?} -> {results: [[...], ...]}   # max 64 textes
```
Auth : bearer partagé `Authorization: Bearer $NER_API_KEY` (si la var est posée ; sinon ouvert = dev only).

## Lancer en local

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
uvicorn app:app --port 8088      # le modèle se charge au démarrage (lifespan warmup)
curl localhost:8088/health
curl -s localhost:8088/extract -H 'content-type: application/json' \
  -d '{"text":"Jean Dupont (Novatech) a migré de Notion vers Memento."}' | jq
```

## Déploiement `otomata-0` (cf. skill `infra:prod-init`)

Service interne (pas exposé publiquement) appelé par la Edge Deno en async après l'`apply`.

- venv + `requirements.txt` (torch CPU) sur la box ;
- **systemd** `memento-ner.service` : `uvicorn app:app --host 127.0.0.1 --port 8088`, `Environment=NER_API_KEY=…` ;
- joignable par la Edge soit via le réseau interne, soit via un sous-domaine **Caddy** restreint (allow-list + bearer) ;
- garder **1 worker** (le modèle = ~1-2 Go RAM, chargé une fois et chaud). Monter en workers seulement si le volume l'exige (le CDC différait l'async dédié à >30-50 pages/j).

## Intégration côté Deno

Après `apply()` : `fetch(NER_URL + "/extract", { headers:{Authorization:"Bearer "+key}, body:{text} })`
→ pour chaque entité renvoyée, lancer la **résolution** (escalier) contre la table `entity` en Postgres.
Appel **non bloquant** (hors chemin chaud) : la page est écrite immédiatement, les mentions se complètent après.
