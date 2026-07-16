/**
 * Onboarding v3 (issue #70) — `ensurePersonalBaseV3` provisionne org perso + base +
 * membership pour un compte sans tenant, et NE FAIT RIEN pour un compte qui a déjà une
 * base. Contrats portés de `onboarding.test.ts` (v2) vers le schéma « base » (ADR 0003).
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     deno test --allow-env --allow-net --config supabase/functions/deno.json \
 *       supabase/functions/_shared/onboarding.v3.test.ts
 * Sans DATABASE_URL → skip (import dynamique après le garde).
 */
import postgres from "postgres";

const DB = Deno.env.get("DATABASE_URL");
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(`assertion failed: ${m}`); }
function assertEquals(a: unknown, b: unknown, m: string) { if (a !== b) throw new Error(`assertion failed: ${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }

Deno.test({
  name: "onboarding v3 — ensurePersonalBaseV3 : provisionne, idempotent, no-op si base existante",
  ignore: !DB,
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { ensurePersonalBaseV3 } = await import("./onboarding.v3.ts");
  const sql = postgres(DB!, { prepare: false });
  const tag = `onbv3-${crypto.randomUUID().slice(0, 8)}`;
  const blank = `${tag}-blank`;   // compte vierge : aucune org
  const member = `${tag}-member`; // compte déjà membre d'une org dotée d'une base
  const created: string[] = []; // org ids à nettoyer

  // org pré-existante pour `member` (cas migré 4As/otomata-business).
  const preName = `${tag}-pre`;
  const [preOrg] = await sql`insert into mem_orgs (slug, name) values (${preName}, ${preName}) returning id`;
  created.push(preOrg.id);
  await sql`insert into mem_bases (org_id, name) values (${preOrg.id}, ${preName + "-base"})`;
  await sql`insert into mem_memberships (org_id, user_id, role) values (${preOrg.id}, ${member}, 'member')`;

  try {
    await t.step("compte vierge → org perso + 1 base + membership admin", async () => {
      await ensurePersonalBaseV3(blank);
      const orgs = await sql`select id, personal_for from mem_orgs where personal_for = ${blank}`;
      assertEquals(orgs.length, 1, "exactement 1 org perso provisionnée");
      created.push(orgs[0].id as string);
      const bases = await sql`select id from mem_bases where org_id = ${orgs[0].id}`;
      assertEquals(bases.length, 1, "exactement 1 base dans l'org perso");
      const mem = await sql`select role from mem_memberships where org_id = ${orgs[0].id} and user_id = ${blank}`;
      assertEquals(mem.length, 1, "membership posée");
      assertEquals(mem[0].role, "admin", "membership = admin");
    });

    await t.step("v3Bases voit la base fraîchement provisionnée", async () => {
      const { v3Bases } = await import("../mcp/v3.ts");
      const { bases } = await v3Bases(blank);
      assertEquals(bases.length, 1, "v3Bases ne renvoie plus [] (cul-de-sac levé)");
    });

    await t.step("idempotent : 2e appel → 0 doublon", async () => {
      await ensurePersonalBaseV3(blank);
      const [{ norg }] = await sql`select count(*)::int norg from mem_orgs where personal_for = ${blank}`;
      assertEquals(Number(norg), 1, "toujours 1 org perso");
      const [{ nbase }] = await sql`select count(*)::int nbase from mem_bases b join mem_orgs o on o.id = b.org_id where o.personal_for = ${blank}`;
      assertEquals(Number(nbase), 1, "toujours 1 base");
    });

    await t.step("compte déjà membre d'une base → AUCUNE org perso créée", async () => {
      await ensurePersonalBaseV3(member);
      const orgs = await sql`select id from mem_orgs where personal_for = ${member}`;
      assertEquals(orgs.length, 0, "pas d'org perso redondante pour un compte déjà doté");
    });

    await t.step("anonyme (sub vide) → no-op", async () => {
      await ensurePersonalBaseV3("");
      const [{ n }] = await sql`select count(*)::int n from mem_orgs where personal_for = ''`;
      assertEquals(Number(n), 0, "aucune org pour sub vide");
    });
  } finally {
    // base → membership → org (la base référence l'org en onDelete restrict).
    for (const orgId of created) {
      await sql`delete from mem_bases where org_id = ${orgId}`;
      await sql`delete from mem_memberships where org_id = ${orgId}`;
      await sql`delete from mem_orgs where id = ${orgId}`;
    }
    await sql.end();
  }
});
