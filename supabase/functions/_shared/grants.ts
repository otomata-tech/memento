/**
 * Grants par KB (issue #60) : accès explicite d'un user à UNE base — élever un
 * membre (curator sur cette KB), restreindre via `visibility=private`, ou
 * inviter un externe (guest) sans l'entrer dans l'org.
 *
 * Un grant donne LECTURE (member) ou ÉCRITURE (curator) — jamais la gouvernance
 * (décision 2026-06-12) : partager/visibilité/transfert restent aux admins de
 * l'org propriétaire (assertWorkspaceAdmin). Invitation guest : même flux
 * d'invitation que les membres d'org (provision GoTrue + email Resend), seul
 * l'atterrissage change (grant au lieu de membership).
 */
import { and, eq } from "drizzle-orm";
import { db, workspaces, workspaceGrants, orgs, memberships } from "./db.ts";
import { assertWorkspaceAdmin, effectiveRole } from "./access.ts";
import { ensureAccount, emailsForSubs } from "./admin.ts";
import { assertWithinLimit } from "./ratelimit.ts";

const ROLES = ["curator", "member"];

async function wsBySlug(slug: string) {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  if (!w) throw new Error(`workspace introuvable: ${slug}`);
  return w;
}

/**
 * Le « qui a accès » complet d'une KB : visibilité, grants explicites, et accès
 * HÉRITÉS de l'org (membres + rôle d'org) quand visibility=org — sans quoi la
 * liste des grants seule est trompeuse. Pour le panneau Partager et mem_grants.
 */
export async function listGrants(sub: string, args: { workspace: string }) {
  await assertWorkspaceAdmin(sub, args.workspace);
  const w = await wsBySlug(args.workspace);
  const rows = await db.select().from(workspaceGrants)
    .where(eq(workspaceGrants.workspaceId, w.id));
  const orgMembers = w.orgId
    ? await db.select({ userId: memberships.userId, role: memberships.role }).from(memberships)
        .where(eq(memberships.orgId, w.orgId))
    : [];
  const emails = await emailsForSubs([
    ...new Set([...rows.map((g) => g.userId), ...orgMembers.map((m) => m.userId)]),
  ]);
  const [org] = w.orgId
    ? await db.select({ slug: orgs.slug, name: orgs.name }).from(orgs).where(eq(orgs.id, w.orgId)).limit(1)
    : [];
  const present = (userId: string, role: string) => {
    const u = emails.get(userId);
    return { userId, email: u?.email ?? null, role, pending: u?.pending ?? false };
  };
  return {
    workspace: w.slug,
    org: org?.slug ?? null,
    orgName: org?.name ?? null,
    visibility: w.visibility,
    grants: rows.map((g) => present(g.userId, g.role))
      .sort((a, b) => (a.email ?? a.userId).localeCompare(b.email ?? b.userId)),
    // Hérités : membres de l'org propriétaire — accès effectif si org OU public
    // (sinon, private : liste informative vide).
    inherited: w.visibility === "org" || w.visibility === "public"
      ? orgMembers.map((m) => present(m.userId, m.role))
          .sort((a, b) => (a.email ?? a.userId).localeCompare(b.email ?? b.userId))
      : [],
  };
}

/**
 * Donne (ou met à jour) l'accès d'un user à UNE KB, par email. Compte inexistant →
 * provisionné + email d'invitation (flux GoTrue partagé avec les orgs).
 */
export async function grantAccess(
  sub: string,
  args: { workspace: string; email: string; role?: string },
) {
  await assertWorkspaceAdmin(sub, args.workspace);
  await assertWithinLimit(sub, "invite"); // un grant peut provisionner + envoyer un email
  const w = await wsBySlug(args.workspace);
  const role = ROLES.includes(args.role ?? "") ? args.role! : "member";
  const account = await ensureAccount(args.email.trim(), {
    scope: "workspace", targetName: w.name, role, inviterSub: sub,
  });

  await db.insert(workspaceGrants)
    .values({ workspaceId: w.id, userId: account.sub, role, createdBy: sub })
    .onConflictDoUpdate({
      target: [workspaceGrants.workspaceId, workspaceGrants.userId],
      set: { role },
    });
  return {
    workspace: w.slug, email: args.email.trim(), role,
    provisioned: account.provisioned, emailSent: account.emailSent, inviteLink: account.inviteLink,
  };
}

/** Retire un accès explicite. (La gouvernance reste à l'org-admin : pas de lockout possible.) */
export async function revokeGrant(sub: string, args: { workspace: string; userId: string }) {
  await assertWorkspaceAdmin(sub, args.workspace);
  const w = await wsBySlug(args.workspace);
  await db.delete(workspaceGrants)
    .where(and(eq(workspaceGrants.workspaceId, w.id), eq(workspaceGrants.userId, args.userId)));
  return { workspace: w.slug, removed: args.userId };
}

/**
 * Change le périmètre d'une KB. Passage à `private` : pose un grant curator au
 * caller (son rôle d'org ne donne plus la lecture — la gouvernance, elle, lui
 * reste par l'org). Passage à `org`/`public` : les grants restent (élévations
 * conservées). `public` = lecture mondiale (anonyme inclus) + galerie + recherche
 * publique ; l'org propriétaire garde son rôle (elle cure sa base publique).
 */
export async function setVisibility(
  sub: string,
  args: { workspace: string; visibility: "org" | "private" | "public" },
) {
  await assertWorkspaceAdmin(sub, args.workspace);
  const w = await wsBySlug(args.workspace);
  if (w.visibility === args.visibility) return { workspace: w.slug, visibility: w.visibility };
  if (args.visibility === "private") {
    await db.insert(workspaceGrants)
      .values({ workspaceId: w.id, userId: sub, role: "curator", createdBy: sub })
      .onConflictDoNothing();
  }
  await db.update(workspaces).set({ visibility: args.visibility }).where(eq(workspaces.id, w.id));
  return { workspace: w.slug, visibility: args.visibility };
}

export { effectiveRole };
