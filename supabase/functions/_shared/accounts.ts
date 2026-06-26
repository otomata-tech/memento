/**
 * Comptes & invitations — machinerie NEUTRE du schéma (ni v2 workspaces, ni v3 bases).
 *
 * Ne touche que `auth.users` (résolution email↔sub), GoTrue (provisioning + lien
 * d'action) et Resend (livraison du mail) — d'où l'extraction hors d'`admin.ts` : un
 * SEUL flux d'invitation, consommé par la v2 (`admin.ts`, `grants.ts`) ET la v3
 * (`admin.v3.ts`, partage de page). Deux atterrissages possibles (membership OU grant),
 * une seule mécanique de compte. Derive don't duplicate.
 *
 * email↔sub via `auth.users` sur la MÊME connexion (db.ts) que le reste du runtime.
 */
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { emailConfigured, sendEmail } from "./email/resend.ts";
import { invitationEmail } from "./email/templates.ts";

/** sub → {email, pending}. pending = compte provisionné (invitation) jamais connecté. */
export async function emailsFor(subs: string[]): Promise<Map<string, { email: string; pending: boolean }>> {
  if (!subs.length) return new Map();
  const list = sql.join(subs.map((s) => sql`${s}`), sql`, `);
  const rows = await db.execute<{ id: string; email: string; signed: boolean }>(
    sql`select id::text as id, email, (last_sign_in_at is not null) as signed
        from auth.users where id::text in (${list})`,
  );
  return new Map([...rows].map((r) => [r.id, { email: r.email, pending: !r.signed }]));
}

/** Alias historique (consommé par grants.ts) — même fonction que `emailsFor`. */
export const emailsForSubs = emailsFor;

/** email → sub. Lève si aucun compte (l'utilisateur doit s'être connecté ≥ 1 fois). */
export async function subForEmail(email: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`select id::text as id from auth.users where email = ${email} limit 1`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`No Supabase account for "${email}" (the user must have signed in at least once)`);
  return id;
}

function gotrueEnv() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("invitation unavailable (service_role missing)");
  // L'invité atterrit sur l'APP (me.mento.cc), pas sur le sous-domaine MCP.
  const appUrl = Deno.env.get("MEMENTO_APP_URL");
  if (!appUrl) throw new Error("MEMENTO_APP_URL missing (invitation redirect)");
  const redirectTo = `${appUrl}/callback`;
  const headers = { "content-type": "application/json", apikey: key, Authorization: `Bearer ${key}` };
  return { url, headers, redirectTo };
}

/**
 * Provisionne le compte (si besoin) ET renvoie le lien d'action GoTrue SANS envoyer
 * de mail — Memento l'envoie lui-même via Resend (cf. deliverInvite). Compte existant →
 * `type=magiclink` ; sinon `invite`.
 */
export async function generateInviteLink(email: string, existing = false): Promise<{ sub: string; link: string }> {
  const { url, headers, redirectTo } = gotrueEnv();
  const res = await fetch(`${url}/auth/v1/admin/generate_link`, {
    method: "POST", headers,
    body: JSON.stringify({ type: existing ? "magiclink" : "invite", email, redirect_to: redirectTo }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[invite] GoTrue generate_link failure:", res.status, data);
    throw new Error("link generation failed");
  }
  const link = data.action_link ?? data.properties?.action_link;
  const sub = data.user?.id ?? data.id;
  if (!link || !sub) throw new Error("unexpected generate_link response");
  return { sub, link };
}

/** Métadonnées d'invitation pour enrichir le mail (org/KB ciblée, rôle, invitant). */
export interface InviteMeta {
  scope: "org" | "workspace";
  targetName: string;
  role?: string;
  inviterSub?: string;
}

/**
 * Envoie le mail d'invitation via Resend pour un lien d'action déjà généré. Si le
 * provider n'est pas configuré ou échoue, retombe sur le lien à transmettre à la main
 * (l'admin le copie depuis l'UI) — aucune perte de fonctionnalité.
 */
export async function deliverInvite(
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
 * Compte pour cet email — existant tel quel, sinon provisionné (GoTrue, sans mail)
 * + mail d'invitation envoyé par Memento via Resend (fallback : lien à transmettre).
 * Brique partagée orgs / grants : UN seul flux d'invitation, deux atterrissages
 * (membership ou grant). `meta` enrichit le mail (org/KB, rôle, invitant).
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
