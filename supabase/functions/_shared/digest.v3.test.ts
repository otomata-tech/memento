/**
 * Digest v3 (#65) — test DB-backed (harness) : seed dans/hors fenêtre → le digest
 * ne retient que le delta récent. S'auto-skip sans DATABASE_URL.
 */
import { runDigest } from "./digest.v3.ts";
import postgres from "postgres";

const DB = Deno.env.get("DATABASE_URL");
const ORG = "55555555-5555-5555-5555-555555555555";
const BASE = "66666666-6666-6666-6666-666666666666";

function assert(c: boolean, msg: string) {
  if (!c) throw new Error("assertion: " + msg);
}

Deno.test({
  name: "digest v3 — delta récent seulement",
  ignore: !DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const sql = postgres(DB!, { prepare: false });
    const cleanup = async () => {
      await sql`delete from mem_entities where org_id = ${ORG}`;
      await sql`delete from mem_bases where org_id = ${ORG}`; // cascade pages/revisions
      await sql`delete from mem_orgs where id = ${ORG}`;
    };
    try {
      await cleanup();
      await sql`insert into mem_orgs (id, slug, name) values (${ORG}, 'dig', 'Dig')`;
      await sql`insert into mem_bases (id, org_id, name) values (${BASE}, ${ORG}, 'B')`;

      // pages : une récente, une vieille (updated_at forcé à -30j)
      await sql`insert into mem_pages (base_id, title, description, body, visibility) values (${BASE}, 'Recent', 'd', 'x', 'org')`;
      await sql`insert into mem_pages (base_id, title, description, body, visibility, updated_at)
                values (${BASE}, 'Vieux', 'd', 'x', 'org', now() - interval '30 days')`;

      // décisions : une récente proposée, une vieille
      await sql`insert into mem_entities (org_id, type, canonical_label, normalised_label, attributes)
                values (${ORG}, 'decision', 'Garder pgvector', 'garder pgvector', '{"status":"proposee"}'::jsonb)`;
      await sql`insert into mem_entities (org_id, type, canonical_label, normalised_label, created_at)
                values (${ORG}, 'decision', 'Vieille décision', 'vieille decision', now() - interval '30 days')`;

      // révisions : une récente, une vieille
      await sql`insert into mem_revisions (base_id, target_type, op, reason, actor) values (${BASE}, 'page', 'create_page', 'r', 'alice')`;
      await sql`insert into mem_revisions (base_id, target_type, op, reason, actor, created_at)
                values (${BASE}, 'page', 'update_page', 'r', 'alice', now() - interval '30 days')`;

      const d = await runDigest(ORG, { sinceDays: 7 });
      assert(d.recentPages.length === 1 && d.recentPages[0].title === "Recent", `recentPages=${JSON.stringify(d.recentPages.map((p) => p.title))}`);
      assert(d.recentDecisions.length === 1 && d.recentDecisions[0].label === "Garder pgvector", `recentDecisions=${d.recentDecisions.length}`);
      assert(d.openDecisions.length === 1, `openDecisions=${d.openDecisions.length}`);
      assert(d.revisions.length === 1 && d.revisions[0].op === "create_page", `revisions=${JSON.stringify(d.revisions.map((r) => r.op))}`);

      await cleanup();
    } finally {
      await sql.end();
    }
  },
});
