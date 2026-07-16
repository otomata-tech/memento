/**
 * Revue Pages v3 (#64) — reject / renvoi (send_back). Test DB-backed (harness).
 * S'auto-skip sans DATABASE_URL.
 */
import { v3ReviewIngestion } from "./v3.ts";
import postgres from "postgres";

const DB = Deno.env.get("DATABASE_URL");
const ORG = "33333333-3333-3333-3333-333333333333";
const BASE = "44444444-4444-4444-4444-444444444444";
const SUB = "reviewer-1";

function assert(c: boolean, msg: string) {
  if (!c) throw new Error("assertion: " + msg);
}

Deno.test({
  name: "review v3 — send_back + reject + idempotence",
  ignore: !DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const sql = postgres(DB!, { prepare: false });
    const cleanup = async () => {
      await sql`delete from mem_bases where org_id = ${ORG}`; // cascade ingestions/revisions/pages
      await sql`delete from mem_memberships where org_id = ${ORG}`;
      await sql`delete from mem_orgs where id = ${ORG}`;
    };
    try {
      await cleanup();
      await sql`insert into mem_orgs (id, slug, name) values (${ORG}, 'rev', 'Rev')`;
      await sql`insert into mem_bases (id, org_id, name) values (${BASE}, ${ORG}, 'B')`;
      await sql`insert into mem_memberships (org_id, user_id, role) values (${ORG}, ${SUB}, 'admin')`;
      const [i1] = await sql<{ id: string }[]>`
        insert into mem_ingestions (base_id, title, status, proposal) values (${BASE}, 'p1', 'PROPOSED', '[]'::jsonb) returning id`;
      const [i2] = await sql<{ id: string }[]>`
        insert into mem_ingestions (base_id, title, status, proposal) values (${BASE}, 'p2', 'PROPOSED', '[]'::jsonb) returning id`;

      // renvoi (send_back) → CHANGES_REQUESTED + review_note
      const r1 = await v3ReviewIngestion(SUB, { ingestionId: i1.id, decision: "send_back", reviewNote: "manque une source" });
      assert(r1.status === "CHANGES_REQUESTED", `send_back status=${r1.status}`);
      const [c1] = await sql<{ status: string; review_note: string }[]>`
        select status, review_note from mem_ingestions where id = ${i1.id}`;
      assert(c1.status === "CHANGES_REQUESTED" && c1.review_note === "manque une source", "send_back persisté");

      // reject → REJECTED
      const r2 = await v3ReviewIngestion(SUB, { ingestionId: i2.id, decision: "reject" });
      assert(r2.status === "REJECTED", `reject status=${r2.status}`);

      // idempotence : re-décider sur un statut terminal → no-op (renvoie le statut courant)
      const r3 = await v3ReviewIngestion(SUB, { ingestionId: i2.id, decision: "send_back" });
      assert(r3.status === "REJECTED", `idempotent terminal=${r3.status}`);

      await cleanup();
    } finally {
      await sql.end();
    }
  },
});
