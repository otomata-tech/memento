/**
 * Access administration (admin UI) — managing an org's members.
 * Admins only, for the targeted org. In-function mirror of the CLI `server/src/admin.ts`.
 *
 * email↔sub resolution via `auth.users` (same DATABASE_URL connection as the CLI).
 * Org creation / workspace assignment stay in the CLI (privileged, rare ops).
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, orgs, memberships, workspaces, workspaceGrants, documents, sections } from "./db.ts";
import { AccessError, accessibleWorkspaceIds } from "./access.ts";
import { slugify } from "./write.ts";
import { assertWithinLimit } from "./ratelimit.ts";
// Machinerie de comptes/invitations (neutre du schéma) → _shared/accounts.ts, partagée v2/v3.
import {
  emailsFor, subForEmail, generateInviteLink, deliverInvite, ensureAccount,
} from "./accounts.ts";

const ROLES = ["admin", "curator", "member"];

async function orgBySlug(slug: string) {
  const [o] = await db.select().from(orgs).where(eq(orgs.slug, slug)).limit(1);
  if (!o) throw new Error(`org not found: ${slug}`);
  return o;
}

async function roleOf(sub: string, orgId: string): Promise<string | null> {
  const [m] = await db.select({ role: memberships.role }).from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, sub))).limit(1);
  return m?.role ?? null;
}

async function assertOrgAdmin(sub: string, orgId: string): Promise<void> {
  if ((await roleOf(sub, orgId)) !== "admin") throw new AccessError("org admins only");
}

// email↔sub & invitation flow vivent dans accounts.ts ; ré-exportés ici pour les
// consommateurs historiques (grants.ts, api/index.ts) — surface inchangée.
export { emailsForSubs } from "./accounts.ts";
export { ensureAccount };

/**
 * User's personal org ("Alexis's Workspace", issue #60) — auto-provisioned on
 * first topological access, idempotent (`mem_orgs.personal_for` unique).
 * Any account (guests included) can therefore create their own KBs there.
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
      .values({ slug, name: `Personal (${local})`, personalFor: sub }).returning();
    await db.insert(memberships).values({ orgId: o.id, userId: sub, role: "admin" })
      .onConflictDoNothing();
  } catch {
    // race lost on unique(personal_for): the other request created the org — nothing to do.
  }
}

/**
 * Onboarding: guarantees a personal org AND ≥ 1 accessible KB. A signed-in account
 * must NEVER be left without a KB (otherwise a dead end on the home screen). If no KB
 * is accessible to them (neither `org`/`public` of one of their orgs, nor granted), creates
 * a default private KB in their personal org (+ curator grant: `private` ⇒ the org role does
 * NOT grant read access to the content, see effectiveRole). Idempotent; anonymous = no-op.
 */
export async function ensureDefaultWorkspace(sub: string): Promise<void> {
  if (!sub) return;
  await ensurePersonalOrg(sub);
  if ((await accessibleWorkspaceIds(sub)).length) return;
  const [perso] = await db.select({ id: orgs.id }).from(orgs)
    .where(eq(orgs.personalFor, sub)).limit(1);
  if (!perso) return; // ensurePersonalOrg just ensured it — defensive.
  const emails = await emailsFor([sub]);
  const local = (emails.get(sub)?.email ?? "perso").split("@")[0];
  let slug = slugify(`${local}-base`);
  const taken = new Set((await db.select({ slug: workspaces.slug }).from(workspaces)).map((w) => w.slug));
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }
  try {
    const [w] = await db.insert(workspaces)
      .values({ slug, name: "My first KB", summary: "", orgId: perso.id, visibility: "private" })
      .returning();
    await db.insert(workspaceGrants)
      .values({ workspaceId: w.id, userId: sub, role: "curator", createdBy: sub })
      .onConflictDoNothing();
  } catch {
    // race lost (two simultaneous requests): the other one created the KB — nothing to do.
  }
}

/**
 * Orgs the caller is a member of, with members (email + role) and workspaces
 * VISIBLE to them: `org` KBs, private ones granted to them, and — if they are
 * org-admin — the EXISTENCE of their org's private KBs (governance: they can
 * share/archive them, not read their content without a grant).
 * Provisions the personal org along the way (topological entry point of the UI).
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
      name: workspaces.name, visibility: workspaces.visibility, archivedAt: workspaces.archivedAt,
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
        .map((w) => ({ slug: w.slug, name: w.name, visibility: w.visibility, archived: !!w.archivedAt })),
    })),
  };
}

/**
 * Invites a member. Existing account → role added/updated (no email). New account →
 * provisioned + invitation email sent by Memento via Resend; if the provider is
 * missing or fails, falls back to a link to be passed along by hand. Org admin required.
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
 * Resends an invitation to a member who has never signed in (pending): magic link
 * generated by GoTrue (no email) then sent by Memento via Resend. Falls back to a link
 * to pass along if the provider is missing/fails. Org admin required.
 */
export async function resendInvite(sub: string, args: { orgSlug: string; email: string }) {
  const org = await orgBySlug(args.orgSlug);
  await assertOrgAdmin(sub, org.id);
  await assertWithinLimit(sub, "invite");
  const email = args.email.trim();
  await subForEmail(email); // must exist (provisioned)
  const { link } = await generateInviteLink(email, true); // magic link (existing account)
  const { emailSent, inviteLink } = await deliverInvite(email, link, {
    scope: "org", targetName: org.name, inviterSub: sub,
  });
  return { orgSlug: org.slug, email, emailSent, inviteLink };
}

/** Sign-in link to pass along by hand (messaging fallback) for an existing account. */
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
 * Creates an org (sharing scope: mission/client, personal) — the creator
 * becomes its admin. No gating beyond authentication: an empty scope
 * exposes nothing. Slug deduplicated globally.
 */
export async function createOrg(sub: string, args: { name: string; slug?: string }) {
  if (!args.name?.trim()) throw new Error("organization name required");
  await assertWithinLimit(sub, "create_org"); // no org-admin gating here → bounds the throughput

  let slug = slugify(args.slug?.trim() || args.name);
  const taken = new Set((await db.select({ slug: orgs.slug }).from(orgs)).map((o) => o.slug));
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }

  const [o] = await db.insert(orgs).values({ slug, name: args.name.trim() }).returning();
  await db.insert(memberships).values({ orgId: o.id, userId: sub, role: "admin" });
  return { slug: o.slug, name: o.name, myRole: "admin" };
}

/**
 * Renames an org (display name and/or slug). Org admin required. The slug is the
 * stable handle used by orgSlug-addressed verbs (create/transfer/grant) — changing
 * it is allowed but must stay globally unique; a collision is a hard error (no silent
 * suffixing, unlike creation). A personal org's slug is locked (it backs `personal_for`).
 */
export async function updateOrg(sub: string, args: { orgSlug: string; name?: string; slug?: string }) {
  const org = await orgBySlug(args.orgSlug);
  await assertOrgAdmin(sub, org.id);

  const patch: { name?: string; slug?: string } = {};
  if (args.name?.trim()) patch.name = args.name.trim();
  if (args.slug?.trim()) {
    if (org.personalFor) throw new Error("a personal org's slug is locked");
    const slug = slugify(args.slug.trim());
    if (slug !== org.slug) {
      const taken = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.slug, slug)).limit(1);
      if (taken.length) throw new Error(`slug already taken: ${slug}`);
      patch.slug = slug;
    }
  }
  if (!patch.name && !patch.slug) throw new Error("nothing to update (provide name and/or slug)");

  const [o] = await db.update(orgs).set(patch).where(eq(orgs.id, org.id)).returning();
  return { slug: o.slug, name: o.name, myRole: "admin" };
}

/**
 * Hard-deletes an org's ARCHIVED workspaces (content first, FK-safe). Archiving is a soft
 * delete and the `workspaces.org_id` FK is `restrict`, so an archived KB would otherwise block
 * its org's deletion forever — and there is no user-facing hard-delete of a KB. This makes
 * "archive the KB, then delete its org" actually work (the deleteOrg message promised it).
 */
/** Hard-purges ONE workspace's content then the workspace row, FK-safe. */
async function purgeWorkspaceContent(wsId: string): Promise<void> {
  // documents → blocks/links/block_sources cascade from documents.
  await db.delete(documents).where(
    inArray(documents.sectionId, db.select({ id: sections.id }).from(sections).where(eq(sections.workspaceId, wsId))),
  );
  // sections: parent_id is RESTRICT — delete leaves first, looping until none remain.
  for (;;) {
    const rows = await db.select({ id: sections.id, parentId: sections.parentId }).from(sections)
      .where(eq(sections.workspaceId, wsId));
    if (!rows.length) break;
    const parents = new Set(rows.map((r) => r.parentId).filter(Boolean) as string[]);
    const leaves = rows.map((r) => r.id).filter((id) => !parents.has(id));
    await db.delete(sections).where(inArray(sections.id, leaves.length ? leaves : rows.map((r) => r.id)));
  }
  // the workspace itself: revisions / ingestions / grants cascade from workspaces;
  // user_prefs.default_workspace_id is SET NULL.
  await db.delete(workspaces).where(eq(workspaces.id, wsId));
}

async function purgeArchivedWorkspaces(orgId: string): Promise<void> {
  const wss = await db.select({ id: workspaces.id }).from(workspaces)
    .where(and(eq(workspaces.orgId, orgId), isNotNull(workspaces.archivedAt)));
  for (const ws of wss) await purgeWorkspaceContent(ws.id);
}

/**
 * Hard-deletes a single workspace (irreversible — every document, block, section, revision and
 * ingestion is purged). Org-admin only, and the KB must be ARCHIVED first: archiving is the
 * deliberate, reversible first step, hard-delete the irreversible second. Mirrors the doc/section
 * hard-deletes; fills the gap that there was no user-facing hard-delete of a whole KB.
 */
export async function deleteWorkspace(sub: string, args: { workspace: string }) {
  const [w] = await db.select({
    id: workspaces.id, slug: workspaces.slug, orgId: workspaces.orgId, archivedAt: workspaces.archivedAt,
  }).from(workspaces).where(eq(workspaces.slug, args.workspace)).limit(1);
  if (!w) throw new Error(`Workspace not found: ${args.workspace}`);
  if (!w.orgId) throw new Error("workspace has no owning org — cannot authorize deletion");
  await assertOrgAdmin(sub, w.orgId);
  if (!w.archivedAt) {
    throw new Error("archive the KB first — deleteWorkspace purges an already-archived KB (archive = reversible step 1, delete = irreversible step 2).");
  }
  await purgeWorkspaceContent(w.id);
  return { deleted: w.slug };
}

/**
 * Deletes an org once it owns no ACTIVE KB and has no member other than the caller — fixes a
 * mistake. Archived KBs do NOT block (they are purged as part of deletion); only live ones do.
 */
export async function deleteOrg(sub: string, args: { orgSlug: string }) {
  const org = await orgBySlug(args.orgSlug);
  await assertOrgAdmin(sub, org.id);
  const [active, members] = await Promise.all([
    db.select({ id: workspaces.id }).from(workspaces)
      .where(and(eq(workspaces.orgId, org.id), isNull(workspaces.archivedAt))).limit(1),
    db.select({ u: memberships.userId }).from(memberships).where(eq(memberships.orgId, org.id)),
  ]);
  if (active.length) throw new Error("the org owns active KBs — archive or reassign them first");
  if (members.some((m) => m.u !== sub)) throw new Error("the org has other members — remove them first");
  await purgeArchivedWorkspaces(org.id); // archived KBs are soft-deleted — remove them so the org can go
  await db.delete(orgs).where(eq(orgs.id, org.id)); // memberships cascade
  return { deleted: org.slug };
}

/**
 * Transfers a KB to another org = change of TENANT (e.g. promoting a KB from the
 * personal org to the team org). The scope (visibility/grants) follows the KB.
 * Gating: admin of BOTH orgs — a per-KB grant NEVER delegates the tenancy
 * (otherwise a guest grant-admin could exfiltrate the KB to their own org).
 */
export async function transferWorkspace(sub: string, args: { workspace: string; toOrg: string }) {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.slug, args.workspace)).limit(1);
  if (!w) throw new Error(`KB not found: ${args.workspace}`);
  if (!w.orgId) throw new Error("KB without an owning org — reassign via the tooling");
  const dest = await orgBySlug(args.toOrg);
  if (dest.id === w.orgId) throw new Error("the KB is already in this org");
  await assertOrgAdmin(sub, w.orgId);
  await assertOrgAdmin(sub, dest.id);
  await db.update(workspaces).set({ orgId: dest.id }).where(eq(workspaces.id, w.id));
  return { workspace: w.slug, toOrg: dest.slug };
}

/**
 * Creates an empty KB in an org the caller is admin of. `visibility` defaults to
 * `org`; `private` → curator grant placed on the creator (read/write — governance
 * stays with them anyway through the org).
 */
export async function createWorkspace(
  sub: string,
  args: { orgSlug: string; name: string; summary?: string; slug?: string; visibility?: "org" | "private" | "public" },
) {
  const org = await orgBySlug(args.orgSlug);
  await assertOrgAdmin(sub, org.id);
  if (!args.name?.trim()) throw new Error("KB name required");
  const visibility = args.visibility === "private" || args.visibility === "public" ? args.visibility : "org";

  // globally unique slug (mem_workspaces.slug is unique across all orgs).
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

/** Removes a member. Admin required. Refuses to remove the last admin (anti-lockout). */
export async function removeMember(sub: string, args: { orgSlug: string; userId: string }) {
  const org = await orgBySlug(args.orgSlug);
  await assertOrgAdmin(sub, org.id);
  const admins = await db.select({ u: memberships.userId }).from(memberships)
    .where(and(eq(memberships.orgId, org.id), eq(memberships.role, "admin")));
  if (admins.length === 1 && admins[0].u === args.userId) {
    throw new Error("cannot remove the last admin of the org");
  }
  await db.delete(memberships).where(and(eq(memberships.orgId, org.id), eq(memberships.userId, args.userId)));
  return { removed: args.userId, orgSlug: org.slug };
}
