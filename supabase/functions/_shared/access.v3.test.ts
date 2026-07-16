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
  isPageEnumerable,
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
// alice=org_admin, bob/dave=membres simples, carol=externe ; erin=membre d'une 2e org.
const sub = { alice: `alice-${r}`, bob: `bob-${r}`, dave: `dave-${r}`, carol: `carol-${r}`, erin: `erin-${r}` };
const id = {
  org: crypto.randomUUID(), base: crypto.randomUUID(),
  root: crypto.randomUUID(), priv: crypto.randomUUID(),
  privChild: crypto.randomUUID(), pub: crypto.randomUUID(), bobPage: crypto.randomUUID(),
  bobPriv: crypto.randomUUID(),
  org2: crypto.randomUUID(), base2: crypto.randomUUID(), pub2: crypto.randomUUID(),
};

async function seed() {
  // Org 1
  await db.execute(sql`insert into mem_orgs(id,slug,name) values (${id.org}::uuid, ${"o-" + r}, 'O')`);
  await db.execute(sql`insert into mem_bases(id,org_id,name) values (${id.base}::uuid, ${id.org}::uuid, 'B')`);
  await db.execute(sql`insert into mem_memberships(org_id,user_id,role) values
    (${id.org}::uuid, ${sub.alice}, 'admin'), (${id.org}::uuid, ${sub.bob}, 'member'), (${id.org}::uuid, ${sub.dave}, 'member')`);
  // root(org,alice) ▸ priv(private,alice) ▸ privChild(org,alice) ; pub(public,alice) ; bobPage(org,bob)
  await db.execute(sql`insert into mem_pages(id,base_id,parent_id,title,visibility,owner_id,depth) values
    (${id.root}::uuid,      ${id.base}::uuid, null,            'root',   'org',     ${sub.alice}, 0),
    (${id.priv}::uuid,      ${id.base}::uuid, ${id.root}::uuid,'priv',   'private', ${sub.alice}, 1),
    (${id.privChild}::uuid, ${id.base}::uuid, ${id.priv}::uuid,'child',  'org',     ${sub.alice}, 2),
    (${id.pub}::uuid,       ${id.base}::uuid, null,            'pub',    'public',  ${sub.alice}, 0),
    (${id.bobPage}::uuid,   ${id.base}::uuid, null,            'bobPage','org',     ${sub.bob},   0),
    (${id.bobPriv}::uuid,   ${id.base}::uuid, null,            'bobPriv','private', ${sub.bob},   0)`);
  await db.execute(sql`insert into mem_page_grants(base_id,page_id,user_id,mode) values
    (${id.base}::uuid, ${id.priv}::uuid, ${sub.carol}, 'read')`);
  // Org 2 (autre tenant) : page PUBLIQUE — bob n'en est pas membre.
  await db.execute(sql`insert into mem_orgs(id,slug,name) values (${id.org2}::uuid, ${"o2-" + r}, 'O2')`);
  await db.execute(sql`insert into mem_bases(id,org_id,name) values (${id.base2}::uuid, ${id.org2}::uuid, 'B2')`);
  await db.execute(sql`insert into mem_memberships(org_id,user_id,role) values (${id.org2}::uuid, ${sub.erin}, 'member')`);
  await db.execute(sql`insert into mem_pages(id,base_id,parent_id,title,visibility,owner_id,depth) values
    (${id.pub2}::uuid, ${id.base2}::uuid, null, 'pub2', 'public', ${sub.erin}, 0)`);
}

async function cleanup() {
  await db.execute(sql`delete from mem_page_grants where base_id = ${id.base}::uuid`);
  for (const pid of [id.privChild, id.priv, id.root, id.pub, id.bobPage, id.bobPriv, id.pub2]) {
    await db.execute(sql`delete from mem_pages where id = ${pid}::uuid`);
  }
  for (const oid of [id.org, id.org2]) {
    await db.execute(sql`delete from mem_memberships where org_id = ${oid}::uuid`);
  }
  await db.execute(sql`delete from mem_bases where id in (${id.base}::uuid, ${id.base2}::uuid)`);
  await db.execute(sql`delete from mem_orgs where id in (${id.org}::uuid, ${id.org2}::uuid)`);
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

    // ── #61 AUTORITÉ D'ÉCRITURE : le membre simple LIT mais n'écrit PAS le canon ──
    assertEquals(await pageReadMode(sub.bob, id.root), "read", "bob (membre) LIT root (org), pas write");
    await assertThrows(() => assertAccess(sub.bob, { pageId: id.root }, { write: true }), "bob (membre) ne peut PAS écrire une page org");
    assertEquals(await pageReadMode(sub.dave, id.bobPage), "read", "dave (membre) lit la page org de bob, pas write");
    // owner & org_admin écrivent
    assertEquals(await pageReadMode(sub.bob, id.bobPage), "write", "bob écrit SA page (owner)");
    assertEquals(await pageReadMode(sub.alice, id.bobPage), "write", "alice (org_admin) écrit la page org de bob");
    await assertAccess(sub.alice, { pageId: id.bobPage }, { write: true });

    // ── #61 ÉNUMÉRATION : le public d'une AUTRE org n'est PAS énumérable (anti-fuite) ──
    assertEquals(await isPageAccessible(sub.bob, id.pub2), true, "bob ACCÈDE pub2 par lien (public)");
    assertEquals(await isPageEnumerable(sub.bob, id.pub2), false, "bob n'ÉNUMÈRE PAS pub2 (public d'une autre org)");
    assert(!(new Set(await accessiblePageIds(sub.bob))).has(id.pub2), "accessible_page_ids(bob) exclut pub2");
    // sa propre page publique reste énumérable (membre)
    assertEquals(await isPageEnumerable(sub.bob, id.pub), true, "bob énumère pub (publique de SA base)");

    // ── alice (proprio) a tout en write ──
    assertEquals(await pageReadMode(sub.alice, id.priv), "write", "alice écrit priv (proprio)");
    await assertAccess(sub.alice, { pageId: id.priv }, { write: true });

    // ── FIX lockout : org_admin lit+ÉCRIT une page PRIVÉE d'un membre (qu'il ne possède PAS) ──
    assertEquals(await pageReadMode(sub.dave, id.bobPriv), null, "dave (membre) ne lit PAS la page privée de bob");
    assertEquals(await isPageAccessible(sub.dave, id.bobPriv), false, "is_page_accessible(dave,bobPriv) = false");
    assertEquals(await pageReadMode(sub.alice, id.bobPriv), "write", "alice (org_admin) ÉCRIT la page privée de bob — pas de lockout");
    await assertAccess(sub.alice, { pageId: id.bobPriv }, { write: true });
    assert((new Set(await accessiblePageIds(sub.alice))).has(id.bobPriv), "alice (admin) énumère bobPriv");
    await assertCanSetVisibility(sub.alice, id.bobPriv, "org"); // l'admin peut TOUJOURS dé-privatiser

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
