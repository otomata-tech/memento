/**
 * Backfill post-migration #58 (CDC §14 pt.4) : sur chaque page migrée, indexe
 * (chunks+embeddings Mistral) + résout les entités (NER serveur). Réutilise les
 * vrais modules v3 (indexing.v3 / entities.v3) → même chemin que l'apply.
 *
 * Lancer (harness ou prod) avec l'import-map deno + les env :
 *   DATABASE_URL (v3) · NER_URL · NER_API_KEY · MEMENTO_MISTRAL_API_KEY
 *   deno run -A --config supabase/functions/deno.json scripts/migrate-v2-to-v3/backfill.ts
 */
import { indexPage } from "../../supabase/functions/_shared/indexing.v3.ts";
import { resolvePageEntities, defaultDeps } from "../../supabase/functions/_shared/entities.ts";
import postgres from "postgres";

const sqlc = postgres(Deno.env.get("DATABASE_URL")!, { prepare: false });

const pages = await sqlc<{ id: string; body: string; org_id: string }[]>`
  select p.id, p.body, b.org_id from mem_pages p
  join mem_bases b on b.id = p.base_id where p.body <> ''`;

let mentions = 0;
for (const p of pages) {
  await indexPage(p.id, p.body); // chunks + embeddings (Mistral)
  const out = await resolvePageEntities(defaultDeps(), { orgId: p.org_id, pageId: p.id, text: p.body });
  mentions += out.length;
}
console.log(`backfill: ${pages.length} pages indexées, ${mentions} mentions résolues`);
await sqlc.end();
