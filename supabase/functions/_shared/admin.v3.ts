/**
 * Memento V3 — administration org/équipe (issue #71). Pendant page-centré de l'admin
 * v2 (`admin.ts`), réécrit sur le schéma BASE (`schema.v3.ts`) au lieu de workspaces.
 *
 * Modèle (ADR 0003) : 1 org = 1 base (mem_bases.org_id UNIQUE) → la base est un
 * attribut OBLIGATOIRE de l'org, pas un objet géré à part. `createOrg` crée donc
 * org + membership(admin) + base d'office (aucun cul-de-sac « org sans base »).
 * Il ne reste pas de `createBase` : on ne peut pas en avoir deux ; seul `renameBase`
 * a un sens. Rôles v3 = admin | member (la v3 abandonne le `curator` de v2).
 *
 * email→sub : via `accounts.ts` (flux d'invitation partagé v2/v3) — `inviteMember`
 * provisionne le compte au besoin et envoie le mail. Mêmes tables `mem_orgs` /
 * `mem_memberships` qu'en v2 (inchangées) ; `mem_bases` est propre à v3.
 *
 * Connexion PROPRIÉTAIRE (contourne la RLS) → pas de `withCurrentSub` ici : l'autz
 * est explicite (`assertOrgAdmin`), comme l'admin v2.
 */
import { sql } from "drizzle-orm";
import { db } from "./db.v3.ts";
import { AccessError } from "./access.v3.ts";
import { slugify } from "./write.ts";
import { assertWithinLimit } from "./ratelimit.ts";
import { ensureAccount, emailsFor } from "./accounts.ts";

const ROLES = ["admin", "member"];
const rows = <T>(r: unknown) => r as unknown as T[];
const one = <T>(r: unknown) => (r as unknown as T[])[0];

type Tx = typeof db;

async function orgBySlug(tx: Tx, slug: string): Promise<{ id: string; slug: string; name: string }> {
  const o = one<{ id: string; slug: string; name: string }>(
    await tx.execute(sql`select id::text as id, slug, name from mem_orgs where slug = ${slug}`),
  );
  if (!o) throw new Error(`org not found: ${slug}`);
  return o;
}

async function roleOf(tx: Tx, sub: string, orgId: string): Promise<string | null> {
  const m = one<{ role: string }>(
    await tx.execute(sql`select role from mem_memberships where org_id = ${orgId}::uuid and user_id = ${sub}`),
  );
  return m?.role ?? null;
}

async function assertOrgAdmin(tx: Tx, sub: string, orgId: string): Promise<void> {
  if ((await roleOf(tx, sub, orgId)) !== "admin") throw new AccessError("org admins only");
}

/** Slug d'org globalement unique (suffixe -2, -3… en cas de collision). */
async function uniqueOrgSlug(tx: Tx, desired: string): Promise<string> {
  let slug = slugify(desired);
  const taken = new Set(rows<{ slug: string }>(await tx.execute(sql`select slug from mem_orgs`)).map((o) => o.slug));
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }
  return slug;
}

/**
 * Crée une org (périmètre de partage : mission/client, perso) — le créateur en devient
 * admin — ET sa base d'office (1 org = 1 base, ADR 0003). Pas de gating au-delà de
 * l'authentification ; le débit est borné par le rate-limit `create_org`.
 */
export async function createOrg(sub: string, args: { name: string; slug?: string; baseName?: string }) {
  if (!args.name?.trim()) throw new Error("organization name required");
  await assertWithinLimit(sub, "create_org");
  return await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const slug = await uniqueOrgSlug(tx, args.slug?.trim() || args.name);
    const o = one<{ id: string; slug: string; name: string }>(await tx.execute(sql`
      insert into mem_orgs (slug, name) values (${slug}, ${args.name.trim()})
      returning id::text as id, slug, name`));
    await tx.execute(sql`insert into mem_memberships (org_id, user_id, role) values (${o.id}::uuid, ${sub}, 'admin')`);
    const baseName = args.baseName?.trim() || o.name;
    const b = one<{ id: string; name: string }>(await tx.execute(sql`
      insert into mem_bases (org_id, name) values (${o.id}::uuid, ${baseName})
      returning id::text as id, name`));
    return { slug: o.slug, name: o.name, myRole: "admin", baseId: b.id, baseName: b.name };
  });
}

/** Renomme la base d'une org (le seul geste « base » qui ait un sens en 1:1). Admin requis. */
export async function renameBase(sub: string, args: { baseId: string; name: string }) {
  if (!args.name?.trim()) throw new Error("base name required");
  return await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const b = one<{ org_id: string }>(await tx.execute(sql`select org_id::text as org_id from mem_bases where id = ${args.baseId}::uuid`));
    if (!b) throw new Error("base not found");
    await assertOrgAdmin(tx, sub, b.org_id);
    const updated = one<{ id: string; name: string }>(await tx.execute(sql`
      update mem_bases set name = ${args.name.trim()} where id = ${args.baseId}::uuid
      returning id::text as id, name`));
    return { baseId: updated.id, name: updated.name };
  });
}

/**
 * Invite un membre (par email). Compte existant → rôle ajouté/mis à jour (sans mail).
 * Nouveau compte → provisionné + mail d'invitation via Resend ; si le provider manque
 * ou échoue, retombe sur un lien à transmettre à la main. Admin d'org requis.
 */
export async function inviteMember(sub: string, args: { orgSlug: string; email: string; role?: string }) {
  return await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const org = await orgBySlug(tx, args.orgSlug);
    await assertOrgAdmin(tx, sub, org.id);
    await assertWithinLimit(sub, "invite");
    const role = ROLES.includes(args.role ?? "") ? args.role! : "member";
    const email = args.email.trim();

    const account = await ensureAccount(email, { scope: "org", targetName: org.name, role, inviterSub: sub });
    await tx.execute(sql`
      insert into mem_memberships (org_id, user_id, role) values (${org.id}::uuid, ${account.sub}, ${role})
      on conflict (org_id, user_id) do update set role = excluded.role`);

    return {
      orgSlug: org.slug, email, role,
      provisioned: account.provisioned, emailSent: account.emailSent, inviteLink: account.inviteLink,
    };
  });
}

/**
 * Change le rôle d'un membre existant (admin|member). Admin requis. Refuse de
 * rétrograder le DERNIER admin (anti-lockout).
 */
export async function setRole(sub: string, args: { orgSlug: string; userId: string; role: string }) {
  const role = ROLES.includes(args.role) ? args.role : null;
  if (!role) throw new Error(`role must be one of: ${ROLES.join(", ")}`);
  return await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const org = await orgBySlug(tx, args.orgSlug);
    await assertOrgAdmin(tx, sub, org.id);
    const current = await roleOf(tx, args.userId, org.id);
    if (current === null) throw new Error("not a member of this org");
    if (current === "admin" && role !== "admin") {
      const admins = rows<{ u: string }>(await tx.execute(sql`
        select user_id as u from mem_memberships where org_id = ${org.id}::uuid and role = 'admin'`));
      if (admins.length === 1) throw new Error("cannot demote the last admin of the org");
    }
    await tx.execute(sql`
      update mem_memberships set role = ${role} where org_id = ${org.id}::uuid and user_id = ${args.userId}`);
    return { orgSlug: org.slug, userId: args.userId, role };
  });
}

/** Retire un membre. Admin requis. Refuse de retirer le dernier admin (anti-lockout). */
export async function removeMember(sub: string, args: { orgSlug: string; userId: string }) {
  return await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const org = await orgBySlug(tx, args.orgSlug);
    await assertOrgAdmin(tx, sub, org.id);
    const admins = rows<{ u: string }>(await tx.execute(sql`
      select user_id as u from mem_memberships where org_id = ${org.id}::uuid and role = 'admin'`));
    if (admins.length === 1 && admins[0].u === args.userId) {
      throw new Error("cannot remove the last admin of the org");
    }
    await tx.execute(sql`delete from mem_memberships where org_id = ${org.id}::uuid and user_id = ${args.userId}`);
    return { removed: args.userId, orgSlug: org.slug };
  });
}

/**
 * Orgs dont l'appelant est membre, avec leurs membres (email + rôle + pending) et leur
 * base (1/org). Lecture qui alimente la vue Org du viewer. Pas de provisioning ici
 * (l'onboarding s'en charge, #70) — pure lecture.
 */
export async function adminOrgs(sub: string) {
  const mine = rows<{ org_id: string; role: string }>(
    await db.execute(sql`select org_id::text as org_id, role from mem_memberships where user_id = ${sub}`),
  );
  if (!mine.length) return { orgs: [] };
  const orgIds = mine.map((m) => m.org_id);
  const myRole = new Map(mine.map((m) => [m.org_id, m.role]));
  const list = sql.join(orgIds.map((id) => sql`${id}`), sql`, `);

  const [orgRows, members, baseRows] = await Promise.all([
    db.execute(sql`select id::text as id, slug, name, personal_for from mem_orgs where id::text in (${list})`),
    db.execute(sql`select org_id::text as org_id, user_id, role from mem_memberships where org_id::text in (${list})`),
    db.execute(sql`select org_id::text as org_id, id::text as id, name from mem_bases where org_id::text in (${list})`),
  ]);
  const orgRowsT = rows<{ id: string; slug: string; name: string; personal_for: string | null }>(orgRows);
  const membersT = rows<{ org_id: string; user_id: string; role: string }>(members);
  const baseRowsT = rows<{ org_id: string; id: string; name: string }>(baseRows);
  const emails = await emailsFor([...new Set(membersT.map((m) => m.user_id))]);

  return {
    orgs: orgRowsT.map((o) => {
      const base = baseRowsT.find((b) => b.org_id === o.id);
      return {
        id: o.id, slug: o.slug, name: o.name, myRole: myRole.get(o.id) ?? null,
        personal: o.personal_for === sub,
        base: base ? { id: base.id, name: base.name } : null,
        members: membersT.filter((m) => m.org_id === o.id)
          .map((m) => {
            const u = emails.get(m.user_id);
            return { userId: m.user_id, email: u?.email ?? null, role: m.role, pending: u?.pending ?? false };
          })
          .sort((a, b) => (a.email ?? a.userId).localeCompare(b.email ?? b.userId)),
      };
    }),
  };
}
