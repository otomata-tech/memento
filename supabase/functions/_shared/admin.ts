/**
 * Administration des accès (UI admin) — gestion des membres d'une org.
 * Réservé aux admins de l'org ciblée. Miroir in-function du CLI `server/src/admin.ts`.
 *
 * Résolution email↔sub via `auth.users` (même connexion DATABASE_URL que le CLI).
 * Création d'org / affectation de workspace restent au CLI (ops privilégiées, rares).
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, orgs, memberships, workspaces, workspaceGrants } from "./db.ts";
import { AccessError, accessibleWorkspaceIds } from "./access.ts";
import { slugify } from "./write.ts";
import { assertWithinLimit } from "./ratelimit.ts";
import { emailConfigured, sendEmail } from "./email/resend.ts";
import { invitationEmail } from "./email/templates.ts";

const ROLES = ["admin", "curator", "member"];

async function emailsFor(subs: string[]): Promise<Map<string, { email: string; pending: boolean }>> {
  if (!subs.length) return new Map();
  const list = sql.join(subs.map((s) => sql`${s}`), sql`, `);
  const rows = await db.execute<{ id: string; email: string; signed: boolean }>(
    sql`select id::text as id, email, (last_sign_in_at is not null) as signed
        from auth.users where id::text in (${list})`,
  );
  // pending = compte provisionné (invitation) jamais connecté.
  return new Map([...rows].map((r) => [r.id, { email: r.email, pending: !r.signed }]));
}

async function subForEmail(email: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`select id::text as id from auth.users where email = ${email} limit 1`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`Aucun compte Supabase pour « ${email} » (l'utilisateur doit s'être connecté au moins une fois)`);
  return id;
}

async function orgBySlug(slug: string) {
  const [o] = await db.select().from(orgs).where(eq(orgs.slug, slug)).limit(1);
  if (!o) throw new Error(`org introuvable: ${slug}`);
  return o;
}

async function roleOf(sub: string, orgId: string): Promise<string | null> {
  const [m] = await db.select({ role: memberships.role }).from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, sub))).limit(1);
  return m?.role ?? null;
}

async function assertOrgAdmin(sub: string, orgId: string): Promise<void> {
  if ((await roleOf(sub, orgId)) !== "admin") throw new AccessError("réservé aux admins de l'org");
}

/** Résolution email→sub pour les autres services (grants). */
export const emailsForSubs = emailsFor;

/**
 * Org perso du user (« Alexis's Workspace », issue #60) — auto-provisionnée au
 * premier accès topologique, idempotente (`mem_orgs.personal_for` unique).
 * Tout compte (guest compris) peut donc créer ses KB chez lui.
 */
export async function ensurePersonalOrg(sub: string): Promise<void> {
  const [existing] = await db.select({ id: orgs.id }).from(orgs)
    .where(eq(orgs.personalFor, sub)).limit(1);
  if (existing) return;
  const emails = await emailsFor([sub]);
  const local = (emails.get(sub)?.email ?? "perso").split("@")[0];
  let slug = slugify(`perso-${local}`);
  const taken = new Set((await db.select({ slug: orgs.slug }).from(orgs)).map((o) => o.slug));
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }
  try {
    const [o] = await db.insert(orgs)
      .values({ slug, name: `Perso (${local})`, personalFor: sub }).returning();
    await db.insert(memberships).values({ orgId: o.id, userId: sub, role: "admin" })
      .onConflictDoNothing();
  } catch {
    // course perdue sur unique(personal_for) : l'autre requête a créé l'org — rien à faire.
  }
}

/**
 * Onboarding : garantit org perso ET ≥ 1 KB accessible. Un compte loggé ne doit
 * JAMAIS rester sans base (sinon cul-de-sac à l'accueil). Si aucune KB ne lui est
 * accessible (ni `org`/`public` d'une de ses orgs, ni grantée), crée une KB privée
 * par défaut dans son org perso (+ grant curator : `private` ⇒ le rôle d'org NE
 * donne PAS la lecture du contenu, cf. effectiveRole). Idempotent ; anonyme = no-op.
 */
export async function ensureDefaultWorkspace(sub: string): Promise<void> {
  if (!sub) return;
  await ensurePersonalOrg(sub);
  if ((await accessibleWorkspaceIds(sub)).length) return;
  const [perso] = await db.select({ id: orgs.id }).from(orgs)
    .where(eq(orgs.personalFor, sub)).limit(1);
  if (!perso) return; // ensurePersonalOrg vient de l'assurer — défensif.
  const emails = await emailsFor([sub]);
  const local = (emails.get(sub)?.email ?? "perso").split("@")[0];
  let slug = slugify(`${local}-base`);
  const taken = new Set((await db.select({ slug: workspaces.slug }).from(workspaces)).map((w) => w.slug));
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }
  try {
    const [w] = await db.insert(workspaces)
      .values({ slug, name: "Ma première base", summary: "", orgId: perso.id, visibility: "private" })
      .returning();
    await db.insert(workspaceGrants)
      .values({ workspaceId: w.id, userId: sub, role: "curator", createdBy: sub })
      .onConflictDoNothing();
  } catch {
    // course perdue (deux requêtes simultanées) : l'autre a créé la KB — rien à faire.
  }
}

/**
 * Orgs dont le caller est membre, avec membres (email + rôle) et workspaces
 * VISIBLES par lui : KB `org`, privées qui lui sont grantées, et — s'il est
 * org-admin — l'EXISTENCE des privées de son org (gouvernance : il peut les
 * partager/archiver, pas en lire le contenu sans grant).
 * Provisionne l'org perso au passage (point d'entrée topologique de l'UI).
 */
export async function listMyOrgs(sub: string) {
  await ensureDefaultWorkspace(sub);
  const mine = await db.select({ orgId: memberships.orgId, role: memberships.role })
    .from(memberships).where(eq(memberships.userId, sub));
  if (!mine.length) return { orgs: [] };
  const orgIds = mine.map((m) => m.orgId);
  const myRole = new Map(mine.map((m) => [m.orgId, m.role]));
  const adminOrgIds = mine.filter((m) => m.role === "admin").map((m) => m.orgId);

  const myGrants = await db.select({ wsId: workspaceGrants.workspaceId })
    .from(workspaceGrants).where(eq(workspaceGrants.userId, sub));
  const grantedIds = myGrants.map((g) => g.wsId);

  const [orgRows, allMembers, wsRows] = await Promise.all([
    db.select().from(orgs).where(inArray(orgs.id, orgIds)),
    db.select().from(memberships).where(inArray(memberships.orgId, orgIds)),
    db.select({
      id: workspaces.id, orgId: workspaces.orgId, slug: workspaces.slug,
      name: workspaces.name, visibility: workspaces.visibility,
    }).from(workspaces).where(and(
      inArray(workspaces.orgId, orgIds),
      or(
        eq(workspaces.visibility, "org"),
        grantedIds.length ? inArray(workspaces.id, grantedIds) : sql`false`,
        adminOrgIds.length ? inArray(workspaces.orgId, adminOrgIds) : sql`false`,
      ),
    )),
  ]);
  const emails = await emailsFor([...new Set(allMembers.map((m) => m.userId))]);

  return {
    orgs: orgRows.map((o) => ({
      id: o.id, slug: o.slug, name: o.name, myRole: myRole.get(o.id) ?? null,
      personal: o.personalFor === sub,
      members: allMembers.filter((m) => m.orgId === o.id)
        .map((m) => {
          const u = emails.get(m.userId);
          return { userId: m.userId, email: u?.email ?? null, role: m.role, pending: u?.pending ?? false };
        })
        .sort((a, b) => (a.email ?? a.userId).localeCompare(b.email ?? b.userId)),
      workspaces: wsRows.filter((w) => w.orgId === o.id)
        .map((w) => ({ slug: w.slug, name: w.name, visibility: w.visibility })),
    })),
  };
}

function gotrueEnv() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("invitation indisponible (service_role absent)");
  // L'invité atterrit sur l'APP (me.mento.cc), pas sur le sous-domaine MCP.
  const appUrl = Deno.env.get("MEMENTO_APP_URL");
  if (!appUrl) throw new Error("MEMENTO_APP_URL absent (redirection invitation)");
  const redirectTo = `${appUrl}/callback`;
  const headers = { "content-type": "application/json", apikey: key, Authorization: `Bearer ${key}` };
  return { url, headers, redirectTo };
}

/**
 * Provisionne le compte (si besoin) ET renvoie le lien d'action GoTrue SANS envoyer
 * d'email — Memento envoie lui-même via Resend (cf. deliverInvite). Pour un compte
 * déjà existant, `type=magiclink` ; sinon `invite`.
 */
async function generateInviteLink(email: string, existing = false): Promise<{ sub: string; link: string }> {
  const { url, headers, redirectTo } = gotrueEnv();
  const res = await fetch(`${url}/auth/v1/admin/generate_link`, {
    method: "POST", headers,
    body: JSON.stringify({ type: existing ? "magiclink" : "invite", email, redirect_to: redirectTo }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[invite] GoTrue generate_link échec:", res.status, data);
    throw new Error("génération du lien échouée");
  }
  const link = data.action_link ?? data.properties?.action_link;
  const sub = data.user?.id ?? data.id;
  if (!link || !sub) throw new Error("réponse generate_link inattendue");
  return { sub, link };
}

/** Métadonnées d'invitation pour enrichir l'email (org/KB ciblée, rôle, invitant). */
export interface InviteMeta {
  scope: "org" | "workspace";
  targetName: string;
  role?: string;
  inviterSub?: string;
}

/**
 * Envoie l'email d'invitation via Resend pour un lien d'action déjà généré. Si le
 * provider n'est pas configuré ou échoue, retombe sur le lien à transmettre à la
 * main (l'admin le copie depuis l'UI) — pas de perte de fonctionnalité.
 */
async function deliverInvite(
  email: string,
  link: string,
  meta?: InviteMeta,
): Promise<{ emailSent: boolean; inviteLink: string | null }> {
  if (!emailConfigured()) return { emailSent: false, inviteLink: link };
  let inviterEmail: string | null = null;
  if (meta?.inviterSub) {
    inviterEmail = (await emailsFor([meta.inviterSub])).get(meta.inviterSub)?.email ?? null;
  }
  try {
    const msg = invitationEmail({
      link,
      scope: meta?.scope ?? "org",
      targetName: meta?.targetName ?? "Memento",
      role: meta?.role,
      inviterEmail,
    });
    await sendEmail({ ...msg, to: email });
    return { emailSent: true, inviteLink: null };
  } catch (_e) {
    return { emailSent: false, inviteLink: link };
  }
}

/**
 * Invite un membre. Compte existant → ajout/màj du rôle (pas d'email). Nouveau compte →
 * provisionné + email d'invitation envoyé par Memento via Resend ; si le provider est
 * absent ou échoue, repli sur un lien à transmettre à la main. Admin de l'org requis.
 */
export async function inviteMember(sub: string, args: { orgSlug: string; email: string; role: string }) {
  const org = await orgBySlug(args.orgSlug);
  await assertOrgAdmin(sub, org.id);
  await assertWithinLimit(sub, "invite");
  const role = ROLES.includes(args.role) ? args.role : "member";
  const email = args.email.trim();

  const account = await ensureAccount(email, { scope: "org", targetName: org.name, role, inviterSub: sub });
  await db.insert(memberships).values({ orgId: org.id, userId: account.sub, role })
    .onConflictDoUpdate({ target: [memberships.orgId, memberships.userId], set: { role } });

  return {
    orgSlug: org.slug, email, role,
    provisioned: account.provisioned, emailSent: account.emailSent, inviteLink: account.inviteLink,
  };
}

/**
 * Compte pour cet email — existant tel quel, sinon provisionné (GoTrue, sans email)
 * + email d'invitation envoyé par Memento via Resend (repli : lien à transmettre).
 * Brique partagée orgs / grants : UN flux d'invitation, deux atterrissages
 * (membership ou grant). `meta` enrichit l'email (org/KB, rôle, invitant).
 */
export async function ensureAccount(
  email: string,
  meta?: InviteMeta,
): Promise<{ sub: string; provisioned: boolean; emailSent: boolean; inviteLink: string | null }> {
  let existing: string | null = null;
  try { existing = await subForEmail(email); } catch { existing = null; }
  if (existing) return { sub: existing, provisioned: false, emailSent: false, inviteLink: null };
  const { sub, link } = await generateInviteLink(email);
  const { emailSent, inviteLink } = await deliverInvite(email, link, meta);
  return { sub, provisioned: true, emailSent, inviteLink };
}

/**
 * Renvoie une invitation à un membre encore jamais connecté (pending) : magic link
 * généré par GoTrue (sans email) puis envoyé par Memento via Resend. Repli sur lien
 * à transmettre si le provider est absent/échoue. Admin de l'org requis.
 */
export async function resendInvite(sub: string, args: { orgSlug: string; email: string }) {
  const org = await orgBySlug(args.orgSlug);
  await assertOrgAdmin(sub, org.id);
  await assertWithinLimit(sub, "invite");
  const email = args.email.trim();
  await subForEmail(email); // doit exister (provisionné)
  const { link } = await generateInviteLink(email, true); // magic link (compte existant)
  const { emailSent, inviteLink } = await deliverInvite(email, link, {
    scope: "org", targetName: org.name, inviterSub: sub,
  });
  return { orgSlug: org.slug, email, emailSent, inviteLink };
}

/** Lien de connexion à transmettre à la main (repli messagerie) pour un compte existant. */
export async function inviteLinkFor(sub: string, args: { orgSlug: string; email: string }) {
  const org = await orgBySlug(args.orgSlug);
  await assertOrgAdmin(sub, org.id);
  await assertWithinLimit(sub, "invite");
  const email = args.email.trim();
  await subForEmail(email);
  const { link } = await generateInviteLink(email, true);
  return { orgSlug: org.slug, email, link };
}

/**
 * Crée une org (périmètre de partage : mission/client, perso) — le créateur en
 * devient admin. Pas de gating au-delà de l'authentification : un périmètre vide
 * n'expose rien. Slug dédupliqué globalement.
 */
export async function createOrg(sub: string, args: { name: string; slug?: string }) {
  if (!args.name?.trim()) throw new Error("nom de l'organisation requis");
  await assertWithinLimit(sub, "create_org"); // pas de gating org-admin ici → borne le débit

  let slug = slugify(args.slug?.trim() || args.name);
  const taken = new Set((await db.select({ slug: orgs.slug }).from(orgs)).map((o) => o.slug));
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }

  const [o] = await db.insert(orgs).values({ slug, name: args.name.trim() }).returning();
  await db.insert(memberships).values({ orgId: o.id, userId: sub, role: "admin" });
  return { slug: o.slug, name: o.name, myRole: "admin" };
}

/** Supprime une org VIDE (aucune KB, aucun membre autre que le caller) — corrige une fausse manip. */
export async function deleteOrg(sub: string, args: { orgSlug: string }) {
  const org = await orgBySlug(args.orgSlug);
  await assertOrgAdmin(sub, org.id);
  const [ws, members] = await Promise.all([
    db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, org.id)).limit(1),
    db.select({ u: memberships.userId }).from(memberships).where(eq(memberships.orgId, org.id)),
  ]);
  if (ws.length) throw new Error("l'org possède des KB — réassigner ou archiver d'abord");
  if (members.some((m) => m.u !== sub)) throw new Error("l'org a d'autres membres — les retirer d'abord");
  await db.delete(orgs).where(eq(orgs.id, org.id)); // memberships en cascade
  return { deleted: org.slug };
}

/**
 * Transfère une KB vers une autre org = changement de TENANT (ex. promouvoir une
 * KB de l'org perso vers l'org d'équipe). Le périmètre (visibility/grants) suit
 * la KB. Gating : admin des DEUX orgs — un grant par base ne délègue JAMAIS la
 * tenancy (sinon un guest grant-admin pourrait exfiltrer la base vers son org).
 */
export async function transferWorkspace(sub: string, args: { workspace: string; toOrg: string }) {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.slug, args.workspace)).limit(1);
  if (!w) throw new Error(`KB introuvable: ${args.workspace}`);
  if (!w.orgId) throw new Error("KB sans org propriétaire — réassigner via l'outillage");
  const dest = await orgBySlug(args.toOrg);
  if (dest.id === w.orgId) throw new Error("la KB est déjà dans cette org");
  await assertOrgAdmin(sub, w.orgId);
  await assertOrgAdmin(sub, dest.id);
  await db.update(workspaces).set({ orgId: dest.id }).where(eq(workspaces.id, w.id));
  return { workspace: w.slug, toOrg: dest.slug };
}

/**
 * Crée une KB vide dans une org dont le caller est admin. `visibility` défaut
 * `org` ; `private` → grant curator posé au créateur (lecture/écriture — la
 * gouvernance lui reste de toute façon par l'org).
 */
export async function createWorkspace(
  sub: string,
  args: { orgSlug: string; name: string; summary?: string; slug?: string; visibility?: "org" | "private" | "public" },
) {
  const org = await orgBySlug(args.orgSlug);
  await assertOrgAdmin(sub, org.id);
  if (!args.name?.trim()) throw new Error("nom de la base requis");
  const visibility = args.visibility === "private" || args.visibility === "public" ? args.visibility : "org";

  // slug global unique (mem_workspaces.slug est unique tous orgs confondus).
  let slug = slugify(args.slug?.trim() || args.name);
  const taken = new Set((await db.select({ slug: workspaces.slug }).from(workspaces)).map((w) => w.slug));
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }

  const [w] = await db.insert(workspaces).values({
    slug, name: args.name.trim(), summary: args.summary?.trim() ?? "", orgId: org.id, visibility,
  }).returning();
  if (visibility === "private") {
    await db.insert(workspaceGrants)
      .values({ workspaceId: w.id, userId: sub, role: "curator", createdBy: sub })
      .onConflictDoNothing();
  }
  return { slug: w.slug, name: w.name, summary: w.summary, orgSlug: org.slug, visibility };
}

/** Retire un membre. Admin requis. Refuse de retirer le dernier admin (anti-lockout). */
export async function removeMember(sub: string, args: { orgSlug: string; userId: string }) {
  const org = await orgBySlug(args.orgSlug);
  await assertOrgAdmin(sub, org.id);
  const admins = await db.select({ u: memberships.userId }).from(memberships)
    .where(and(eq(memberships.orgId, org.id), eq(memberships.role, "admin")));
  if (admins.length === 1 && admins[0].u === args.userId) {
    throw new Error("impossible de retirer le dernier admin de l'org");
  }
  await db.delete(memberships).where(and(eq(memberships.orgId, org.id), eq(memberships.userId, args.userId)));
  return { removed: args.userId, orgSlug: org.slug };
}
