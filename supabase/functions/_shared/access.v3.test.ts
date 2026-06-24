/**
 * Test NÉGATIF de l'accès par page v3 (issue #56, ADR 0003) contre un vrai
 * Postgres migré v3 (migrations supabase/migrations/*). Vérifie le verrou : une
 * page privée d'autrui est inaccessible (lecture ET écriture), un invité est
 * borné à sa page (+ son sous-arbre hérité), le public reste lien-seul.
 *
 * Prérequis : DB locale migrée v3. Lancer :
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     deno test --allow-env --allow-net --allow-read \
 *       supabase/functions/_shared/access.v3.test.ts
 */
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  AccessError,
  accessiblePageIds,
  assertAccess,
  assertCanSetVisibility,
  isPageAccessible,
  pageReadMode,
} from "./access.v3.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`assertion failed: ${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
async function assertThrows(fn: () => Promise<unknown>, msg: string) {
  try { await fn(); } catch (e) { assert(e instanceof AccessError, `${msg}: expected AccessError, got ${e}`); return; }
  throw new Error(`assertion failed: ${msg} (no throw)`);
}

// Identifiants uniques par run (tree partagé, exécutions concurrentes possibles).
const r = crypto.randomUUID().slice(0, 8);
const sub = { alice: `alice-${r}`, bob: `bob-${r}`, carol: `carol-${r}` };
const id = {
  org: crypto.randomUUID(), base: crypto.randomUUID(),
  root: crypto.randomUUID(), priv: crypto.randomUUID(),
  privChild: crypto.randomUUID(), pub: crypto.randomUUID(),
};

async function seed() {
  await db.execute(sql`insert into mem_orgs(id,slug,name) values (${id.org}::uuid, ${"o-" + r}, 'O')`);
  await db.execute(sql`insert into mem_bases(id,org_id,name) values (${id.base}::uuid, ${id.org}::uuid, 'B')`);
  await db.execute(sql`insert into mem_memberships(org_id,user_id,role) values
    (${id.org}::uuid, ${sub.alice}, 'admin'), (${id.org}::uuid, ${sub.bob}, 'member')`);
  // root(org,alice) ▸ priv(private,alice) ▸ privChild(org,alice) ; pub(public,alice)
  await db.execute(sql`insert into mem_pages(id,base_id,parent_id,title,visibility,owner_id,depth) values
    (${id.root}::uuid,      ${id.base}::uuid, null,            'root',  'org',     ${sub.alice}, 0),
    (${id.priv}::uuid,      ${id.base}::uuid, ${id.root}::uuid,'priv',  'private', ${sub.alice}, 1),
    (${id.privChild}::uuid, ${id.base}::uuid, ${id.priv}::uuid,'child', 'org',     ${sub.alice}, 2),
    (${id.pub}::uuid,       ${id.base}::uuid, null,            'pub',   'public',  ${sub.alice}, 0)`);
  // carol = externe (aucune membership), invitée en LECTURE sur priv.
  await db.execute(sql`insert into mem_page_grants(base_id,page_id,user_id,mode) values
    (${id.base}::uuid, ${id.priv}::uuid, ${sub.carol}, 'read')`);
}

async function cleanup() {
  await db.execute(sql`delete from mem_page_grants where base_id = ${id.base}::uuid`);
  // enfants d'abord (parent_id ON DELETE RESTRICT)
  for (const pid of [id.privChild, id.priv, id.root, id.pub]) {
    await db.execute(sql`delete from mem_pages where id = ${pid}::uuid`);
  }
  await db.execute(sql`delete from mem_memberships where org_id = ${id.org}::uuid`);
  await db.execute(sql`delete from mem_bases where id = ${id.base}::uuid`);
  await db.execute(sql`delete from mem_orgs where id = ${id.org}::uuid`);
}

// Le client postgres-js de db.ts est un singleton partagé entre fichiers de test
// (le fermer ici casserait les autres) → on désactive le sanitizer, comme load.test.ts.
Deno.test({
  name: "v3 access — page privée d'autrui inaccessible ; invité borné ; public lien-seul",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
  await seed();
  try {
    // ── NÉGATIF : bob (membre) ne lit PAS la page privée d'alice ni son enfant ──
    assertEquals(await pageReadMode(sub.bob, id.priv), null, "bob ne lit pas priv");
    assertEquals(await pageReadMode(sub.bob, id.privChild), null, "bob ne lit pas l'enfant org sous priv (héritage du gate)");
    assertEquals(await isPageAccessible(sub.bob, id.priv), false, "is_page_accessible(bob,priv) = false");
    await assertThrows(() => assertAccess(sub.bob, { pageId: id.priv }), "assertAccess(bob,priv) doit lever");

    // bob lit bien les pages org/public de sa base
    assertEquals(await isPageAccessible(sub.bob, id.root), true, "bob lit root (org)");
    const bobAcc = new Set(await accessiblePageIds(sub.bob));
    assert(bobAcc.has(id.root) && bobAcc.has(id.pub), "bob énumère root + pub");
    assert(!bobAcc.has(id.priv) && !bobAcc.has(id.privChild), "bob n'énumère PAS priv/child");

    // ── alice (proprio) a tout en write ──
    assertEquals(await pageReadMode(sub.alice, id.priv), "write", "alice écrit priv (proprio)");
    await assertAccess(sub.alice, { pageId: id.priv }, { write: true });

    // ── carol (invité externe, read sur priv) : bornée à priv + enfant hérité ──
    assertEquals(await pageReadMode(sub.carol, id.priv), "read", "carol lit priv (grant)");
    assertEquals(await pageReadMode(sub.carol, id.privChild), "read", "carol hérite l'enfant en read");
    assertEquals(await pageReadMode(sub.carol, id.root), null, "carol ne remonte PAS à root");
    assertEquals(await pageReadMode(sub.carol, id.pub), null, "carol n'énumère pas pub (non-membre)");
    const carolAcc = new Set(await accessiblePageIds(sub.carol));
    assertEquals(carolAcc.size, 2, "carol énumère exactement priv + child");
    await assertThrows(() => assertAccess(sub.carol, { pageId: id.priv }, { write: true }), "carol ne peut PAS écrire (read-only)");

    // ── publication (public) : réservée owner|org_admin ──
    await assertThrows(() => assertCanSetVisibility(sub.bob, id.root, "public"), "bob (membre simple) ne publie pas");
    await assertCanSetVisibility(sub.alice, id.root, "public"); // proprio → OK

    // ── base : membre OK, non-membre KO ──
    await assertAccess(sub.bob, { baseId: id.base });
    await assertThrows(() => assertAccess(sub.carol, { baseId: id.base }), "carol non-membre n'a pas la base");
  } finally {
    await cleanup();
  }
  },
});
