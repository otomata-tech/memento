/**
 * Admin org/équipe v3 (issue #71) — createOrg (org + base + membership admin),
 * inviteMember par email (compte existant), setRole + anti-lockout dernier admin,
 * adminOrgs (membres + email résolu + base), renameBase, removeMember + anti-lockout.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     deno test --allow-env --allow-net --config supabase/functions/deno.json \
 *       supabase/functions/_shared/admin.v3.test.ts
 * Sans DATABASE_URL → skip (import dynamique après le garde).
 */
import postgres from "postgres";

const DB = Deno.env.get("DATABASE_URL");
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(`assertion failed: ${m}`); }
function assertEquals(a: unknown, b: unknown, m: string) { if (a !== b) throw new Error(`assertion failed: ${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }

Deno.test({
  name: "admin v3 — createOrg/invite/setRole/adminOrgs/renameBase/removeMember + anti-lockout",
  ignore: !DB,
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { createOrg, renameBase, inviteMember, setRole, removeMember, adminOrgs } = await import("./admin.v3.ts");
  const sql = postgres(DB!, { prepare: false });
  const tag = `adminv3-${crypto.randomUUID().slice(0, 8)}`;
  const admin = `${tag}-admin`;
  const inviteeId = crypto.randomUUID();
  const inviteeEmail = `${tag}@example.com`;
  const slugs: string[] = [];

  // Table rate-limit (parfois non migrée en local) — createOrg/invite la touchent.
  await sql`create table if not exists mem_rate_limits (
    sub text not null, bucket text not null, window_start timestamptz not null,
    count int not null default 0, primary key (sub, bucket, window_start))`;
  // Compte invité pré-existant dans la vraie table auth.users (signed-in → non pending).
  await sql`insert into auth.users (id, email, last_sign_in_at) values (${inviteeId}::uuid, ${inviteeEmail}, now())`;

  let createdSlug = "";
  try {
    await t.step("createOrg → org + membership admin + 1 base", async () => {
      const r = await createOrg(admin, { name: `${tag} Org` });
      createdSlug = r.slug; slugs.push(r.slug);
      assert(r.baseId, "base créée");
      assertEquals(r.myRole, "admin", "créateur = admin");
      const [m] = await sql`select role from mem_memberships where user_id=${admin} and org_id=(select id from mem_orgs where slug=${createdSlug})`;
      assertEquals(m.role, "admin", "membership admin posée");
      const [b] = await sql`select count(*)::int n from mem_bases where org_id=(select id from mem_orgs where slug=${createdSlug})`;
      assertEquals(Number(b.n), 1, "exactement 1 base");
    });

    await t.step("inviteMember (compte existant) → membre ajouté, non provisionné", async () => {
      const r = await inviteMember(admin, { orgSlug: createdSlug, email: inviteeEmail, role: "member" });
      assertEquals(r.provisioned, false, "compte existant : pas de provisioning");
      const [m] = await sql`select role from mem_memberships where user_id=${inviteeId} and org_id=(select id from mem_orgs where slug=${createdSlug})`;
      assertEquals(m.role, "member", "membre ajouté en member");
    });

    await t.step("setRole : promotion puis anti-lockout du dernier admin", async () => {
      await setRole(admin, { orgSlug: createdSlug, userId: inviteeId, role: "admin" });
      await setRole(admin, { orgSlug: createdSlug, userId: inviteeId, role: "member" }); // redescend → 1 seul admin
      let threw = false;
      try { await setRole(admin, { orgSlug: createdSlug, userId: admin, role: "member" }); } catch { threw = true; }
      assert(threw, "refuse de rétrograder le dernier admin");
    });

    await t.step("adminOrgs : org + 2 membres + email résolu + base", async () => {
      const r = await adminOrgs(admin);
      const o = r.orgs.find((x) => x.slug === createdSlug);
      assert(o, "org listée");
      assert(o!.base, "base présente dans la lecture");
      assertEquals(o!.members.length, 2, "2 membres");
      assertEquals(o!.members.find((m) => m.userId === inviteeId)?.email, inviteeEmail, "email résolu via auth.users");
    });

    await t.step("renameBase : renomme la base de l'org", async () => {
      const o = (await adminOrgs(admin)).orgs.find((x) => x.slug === createdSlug)!;
      const r = await renameBase(admin, { baseId: o.base!.id, name: "KB renommée" });
      assertEquals(r.name, "KB renommée", "base renommée");
    });

    await t.step("removeMember : retire le membre, anti-lockout dernier admin", async () => {
      await removeMember(admin, { orgSlug: createdSlug, userId: inviteeId });
      const [c] = await sql`select count(*)::int n from mem_memberships where org_id=(select id from mem_orgs where slug=${createdSlug})`;
      assertEquals(Number(c.n), 1, "reste le seul admin");
      let threw = false;
      try { await removeMember(admin, { orgSlug: createdSlug, userId: admin }); } catch { threw = true; }
      assert(threw, "refuse de retirer le dernier admin");
    });
  } finally {
    for (const s of slugs) {
      await sql`delete from mem_bases where org_id=(select id from mem_orgs where slug=${s})`;
      await sql`delete from mem_memberships where org_id=(select id from mem_orgs where slug=${s})`;
      await sql`delete from mem_orgs where slug=${s}`;
    }
    await sql`delete from auth.users where id=${inviteeId}::uuid`;
    await sql.end();
  }
});
