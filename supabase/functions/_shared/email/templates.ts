/**
 * Gabarits d'email transactionnel — HTML inline + texte brut, rendus en chaînes
 * côté serveur (pas de build React Email dans le runtime Deno edge). Sobre, une
 * seule action par mail (CTA → lien d'invitation / de connexion).
 */
import type { EmailMessage } from "./resend.ts";

const BRAND = "Memento";
const ACCENT = "#4338ca";
const INK = "#1f2937";
const MUTED = "#6b7280";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));
}

function roleLabel(role?: string): string {
  switch (role) {
    case "admin": return "administrateur";
    case "curator": return "curateur (lecture + écriture)";
    case "member": return "lecteur";
    default: return "";
  }
}

/** Coque HTML commune : conteneur centré, CTA, pied de page. */
function layout(intro: string, ctaLabel: string, link: string, outro: string): string {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr><td style="padding:28px 32px 8px;">
          <div style="font-size:18px;font-weight:700;color:${ACCENT};letter-spacing:-0.01em;">${BRAND}</div>
        </td></tr>
        <tr><td style="padding:8px 32px 4px;color:${INK};font-size:15px;line-height:1.55;">${intro}</td></tr>
        <tr><td style="padding:24px 32px;">
          <a href="${escapeHtml(link)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;">${ctaLabel}</a>
        </td></tr>
        <tr><td style="padding:0 32px 28px;color:${MUTED};font-size:13px;line-height:1.5;">${outro}</td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #f0f0f0;color:${MUTED};font-size:12px;">
          ${BRAND} — base de connaissance structurée, sourcée et auditable.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export interface InviteEmailContext {
  link: string;
  scope: "org" | "workspace";
  targetName: string;
  role?: string;
  inviterEmail?: string | null;
}

/**
 * Email d'invitation / de connexion : on a été ajouté à une org ou à une KB, le
 * CTA pointe vers le lien d'action GoTrue (invite ou magic link) qui provisionne
 * la session puis redirige vers l'app.
 */
export function invitationEmail(ctx: InviteEmailContext): EmailMessage {
  const scopeWord = ctx.scope === "org" ? "l'organisation" : "la base de connaissance";
  const name = escapeHtml(ctx.targetName);
  const inviter = ctx.inviterEmail
    ? `<strong>${escapeHtml(ctx.inviterEmail)}</strong> vous invite`
    : "Vous êtes invité·e";
  const role = roleLabel(ctx.role);
  const roleLine = role ? ` en tant que <strong>${role}</strong>` : "";

  const subject = `Invitation à rejoindre ${ctx.targetName} sur ${BRAND}`;
  const intro = `${inviter} à rejoindre ${scopeWord} <strong>${name}</strong>${roleLine} sur ${BRAND}.`;
  const outro = "Ce lien vous connecte et vous redirige vers l'application. Si vous n'attendiez pas cette invitation, ignorez ce message.";
  const html = layout(intro, "Rejoindre " + name, ctx.link, outro);

  const roleText = role ? ` en tant que ${role}` : "";
  const inviterText = ctx.inviterEmail ? `${ctx.inviterEmail} vous invite` : "Vous êtes invité·e";
  const text = [
    `${inviterText} à rejoindre ${scopeWord} « ${ctx.targetName} »${roleText} sur ${BRAND}.`,
    "",
    "Ouvrez ce lien pour vous connecter :",
    ctx.link,
    "",
    "Si vous n'attendiez pas cette invitation, ignorez ce message.",
  ].join("\n");

  return { to: "", subject, html, text };
}
