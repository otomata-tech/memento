# Migration de données v2 → v3 (#58, CDC §14)

Migration **cross-DB** du modèle bloc-centré (v2) vers page-centré (v3). Deux étapes :

1. **`migrate.ts`** — transform structurel : org→base, workspace→page racine, section→page
   (arbre), document→page (body = blocs concaténés, type→markdown), `SUPERSEDES`→note prose
   sur la page cible, sources→`mem_sources`+`page_sources`, descriptions = les `summary` v2.
   Idempotent par `client_key` (`ws:`/`sec:`/`doc:`). **Sans LLM ni NER.**
2. **`backfill.ts`** — post-migration : sur chaque page, `indexPage` (chunks+embeddings Mistral)
   + `resolvePageEntities` (NER serveur) → recherche sémantique + entités/mentions opérationnelles.

## Lancer (dry-run sur un harness, JAMAIS la prod en direct)

```bash
# conteneur pgvector : memento (v3, 3 migrations supabase/migrations) + memento_v2 (v2, server/drizzle)
export V2_DATABASE_URL=postgres://…/memento_v2
export V3_DATABASE_URL=postgres://…/memento
deno run -A --config supabase/functions/deno.json scripts/migrate-v2-to-v3/migrate.ts

export DATABASE_URL=$V3_DATABASE_URL NER_URL=… NER_API_KEY=… MEMENTO_MISTRAL_API_KEY=…
deno run -A --config supabase/functions/deno.json scripts/migrate-v2-to-v3/backfill.ts
```

Prouvé sur un harness (fixture v2 → arbre v3 correct, body/sources/SUPERSEDES OK ; backfill réel : chunks+embeddings 1024 + entités NER).

## Décisions actées (cf. issue #58)
- **org multi-workspaces** → chaque workspace = une page racine sous la base unique de l'org.
- **`SUPERSEDES` bloc→page** → note prose sur la page cible (précision bloc perdue, inhérent au page-centré).
- types de blocs → markdown (sémantique de typage abandonnée, ADR 0001).

## WIP / reste
- Cas limites : workspaces archivés (→ `deprecated` ?), `comments`, métadonnées (`created_by`…).
- Run réel : dépend de la topo de **déploiement/cutover** (connexion v2→v3 prod).
