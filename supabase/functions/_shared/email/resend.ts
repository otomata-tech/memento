/**
 * Envoi d'email transactionnel via Resend (HTTP API, pas de SMTP).
 *
 * Secrets (lus depuis l'env — repo PUBLIC, jamais en dur) :
 *   - RESEND_API_KEY     : clé API Resend
 *   - MEMENTO_EMAIL_FROM : expéditeur, ex. "Memento <no-reply@mento.cc>"
 *
 * Memento envoie lui-même ses emails (invitations) plutôt que de déléguer au SMTP
 * GoTrue : gabarit maîtrisé, lien d'action généré côté serveur. Si le provider
 * n'est pas configuré ou échoue, l'appelant retombe sur un lien à transmettre à la
 * main (cf. ensureAccount) — pas de perte de fonctionnalité.
 */
const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Vrai si le provider est utilisable (clé + expéditeur présents). */
export function emailConfigured(): boolean {
  return !!Deno.env.get("RESEND_API_KEY") && !!Deno.env.get("MEMENTO_EMAIL_FROM");
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Envoie un email via Resend. Lève si non configuré ou si l'API refuse. */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("MEMENTO_EMAIL_FROM");
  if (!key || !from) throw new Error("provider email non configuré (RESEND_API_KEY / MEMENTO_EMAIL_FROM)");

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[email] Resend échec:", res.status, detail);
    throw new Error("envoi email échoué");
  }
}
