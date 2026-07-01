/**
 * Connexion DB de la surface v3 — IDENTIQUE à db.ts, mais la connexion pose
 * `search_path = memento_v3, public, extensions`. Raison (cutover 2026-06-28,
 * consolidation in-project, issue #58) : v3 vit dans le schéma `memento_v3` du
 * MÊME projet Supabase que v2 (auth partagée) ; les tables v3 y sont, tandis que
 * les extensions (vector/unaccent) + la config FTS `french_unaccent` restent
 * partagées dans `public`, et pgcrypto dans `extensions` → les trois schémas dans
 * le path. Les secrets de functions étant au niveau PROJET, on ne peut pas donner
 * un search_path distinct aux functions v3 via le secret sans casser v2 : on le
 * pose donc ICI, dans le code v3 uniquement (les modules *.v3.ts importent ce
 * module ; v2 garde db.ts → `public`). Post-retrait de v2, `memento_v3` pourra
 * être renommé `public` et ce module réaligné (ou supprimé).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export * from "../../../server/src/schema.ts";

const connectionString = Deno.env.get("DATABASE_URL");
if (!connectionString) throw new Error("DATABASE_URL is missing");
export const client = postgres(connectionString, {
  prepare: false,
  connection: { options: "-c search_path=memento_v3,public,extensions" },
});
export const db = drizzle(client);
