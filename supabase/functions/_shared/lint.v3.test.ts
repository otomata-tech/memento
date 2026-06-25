/**
 * Lint v3 (#63) — test DB-backed (harness). Seed des défauts connus → rapport
 * attendu + idempotence du feed de revue. S'auto-skip sans DATABASE_URL.
 */
import { runLint } from "./lint.v3.ts";
import postgres from "postgres";

const DB = Deno.env.get("DATABASE_URL");
const ORG = "11111111-1111-1111-1111-111111111111";
const BASE = "22222222-2222-2222-2222-222222222222";

function assert(c: boolean, msg: string) {
  if (!c) throw new Error("assertion: " + msg);
}

Deno.test({
  name: "lint v3 — défauts détectés + feed de revue idempotent",
  ignore: !DB,
  sanitizeResources: false, // db.ts garde un client postgres singleton ouvert
  sanitizeOps: false,
  fn: async () => {
    const sql = postgres(DB!, { prepare: false });
    // org→base = ON DELETE RESTRICT → nettoyer dans l'ordre FK (entités→bases→org).
    const cleanup = async () => {
      await sql`delete from mem_entities where org_id = ${ORG}`; // cascade entity_reviews
      await sql`delete from mem_bases where org_id = ${ORG}`; // cascade pages
      await sql`delete from mem_memberships where org_id = ${ORG}`;
      await sql`delete from mem_orgs where id = ${ORG}`;
    };
    try {
      await cleanup(); // reset isolé
      await sql`insert into mem_orgs (id, slug, name) values (${ORG}, 'lint-test', 'LintTest')`;
      await sql`insert into mem_bases (id, org_id, name) values (${BASE}, ${ORG}, 'B')`;

      // page A : sans description (body non vide) → pagesNoDescription
      await sql`insert into mem_pages (base_id, title, description, body, visibility)
                values (${BASE}, 'A', '', 'du contenu', 'org')`;
      // page B : description ok mais body vide, sans enfant ni source → emptyLeafPages
      await sql`insert into mem_pages (base_id, title, description, body, visibility)
                values (${BASE}, 'B', 'desc B', '', 'org')`;

      // entités : 2 quasi-doublons (entreprise) + 1 stub (personne)
      await sql`insert into mem_entities (org_id, type, canonical_label, normalised_label, is_stub)
                values (${ORG}, 'entreprise', 'Acme Corp', 'acme corp', false),
                       (${ORG}, 'entreprise', 'Acme Corps', 'acme corps', false),
                       (${ORG}, 'personne', 'Jean Dupont', 'jean dupont', true)`;

      const r1 = await runLint(ORG, { feedReview: true });
      assert(r1.pagesNoDescription === 1, `pagesNoDescription=${r1.pagesNoDescription}`);
      assert(r1.emptyLeafPages === 1, `emptyLeafPages=${r1.emptyLeafPages}`);
      assert(r1.entityStubs === 1, `entityStubs=${r1.entityStubs}`);
      assert(r1.entityNearDuplicates === 1, `entityNearDuplicates=${r1.entityNearDuplicates}`);
      assert(r1.reviewSuggestionsCreated === 1, `reviewSuggestionsCreated=${r1.reviewSuggestionsCreated}`);
      assert(r1.score < 100 && r1.score >= 0, `score=${r1.score}`);

      // file de revue : 1 suggestion pending créée
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int n from mem_entity_reviews where org_id = ${ORG} and status = 'pending'`;
      assert(Number(n) === 1, `entity_reviews pending=${n}`);

      // idempotence : 2e run ne re-détecte PAS la paire déjà en revue
      const r2 = await runLint(ORG, { feedReview: true });
      assert(r2.entityNearDuplicates === 0, `2e run entityNearDuplicates=${r2.entityNearDuplicates}`);
      assert(r2.reviewSuggestionsCreated === 0, `2e run created=${r2.reviewSuggestionsCreated}`);

      await cleanup();
    } finally {
      await sql.end();
    }
  },
});
