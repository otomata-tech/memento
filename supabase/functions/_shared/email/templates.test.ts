/**
 * Tests unitaires purs des gabarits d'email + détection de config (pas de DB ni
 * réseau). Lancement :
 *   deno test --allow-env supabase/functions/_shared/email/templates.test.ts
 */
import { invitationEmail } from "./templates.ts";
import { emailConfigured } from "./resend.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion échouée : ${msg}`);
}

Deno.test("invitationEmail — org, rôle et invitant rendus", () => {
  const msg = invitationEmail({
    link: "https://me.mento.cc/callback#token=abc",
    scope: "org",
    targetName: "Otomata",
    role: "curator",
    inviterEmail: "alexis@otomata.tech",
  });
  assert(msg.subject.includes("Otomata"), "sujet nomme l'org");
  assert(msg.html.includes("https://me.mento.cc/callback#token=abc"), "lien dans le HTML");
  assert(msg.text.includes("https://me.mento.cc/callback#token=abc"), "lien dans le texte");
  assert(msg.html.includes("curateur"), "rôle libellé dans le HTML");
  assert(msg.html.includes("alexis@otomata.tech"), "invitant mentionné");
  assert(msg.html.includes("l'organisation"), "scope org");
});

Deno.test("invitationEmail — workspace sans rôle ni invitant", () => {
  const msg = invitationEmail({
    link: "https://me.mento.cc/callback",
    scope: "workspace",
    targetName: "4 As — Veille",
  });
  assert(msg.html.includes("la base de connaissance"), "scope KB");
  assert(msg.html.includes("Vous êtes invité"), "fallback sans invitant");
  assert(!msg.html.includes("en tant que"), "pas de ligne rôle si absent");
});

Deno.test("invitationEmail — échappement HTML du nom de cible", () => {
  const msg = invitationEmail({
    link: "https://x/y",
    scope: "org",
    targetName: '<script>alert("x")</script>',
  });
  assert(!msg.html.includes("<script>"), "balise injectée échappée");
  assert(msg.html.includes("&lt;script&gt;"), "rendu échappé présent");
});

Deno.test("emailConfigured — vrai seulement si clé ET expéditeur", () => {
  const prevKey = Deno.env.get("RESEND_API_KEY");
  const prevFrom = Deno.env.get("MEMENTO_EMAIL_FROM");
  try {
    Deno.env.delete("RESEND_API_KEY");
    Deno.env.delete("MEMENTO_EMAIL_FROM");
    assert(!emailConfigured(), "non configuré sans secrets");

    Deno.env.set("RESEND_API_KEY", "re_test");
    assert(!emailConfigured(), "clé seule ne suffit pas");

    Deno.env.set("MEMENTO_EMAIL_FROM", "Memento <no-reply@mento.cc>");
    assert(emailConfigured(), "configuré avec clé + expéditeur");
  } finally {
    prevKey === undefined ? Deno.env.delete("RESEND_API_KEY") : Deno.env.set("RESEND_API_KEY", prevKey);
    prevFrom === undefined ? Deno.env.delete("MEMENTO_EMAIL_FROM") : Deno.env.set("MEMENTO_EMAIL_FROM", prevFrom);
  }
});
