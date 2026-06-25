/**
 * Découvrabilité v3 (#66) — garde-fous sur le préambule/prompt (sans DB).
 */
import { V3_INSTRUCTIONS, RECOMMENDED_SYSTEM_PROMPT } from "./discoverability.v3.ts";

function assert(c: boolean, msg: string) {
  if (!c) throw new Error("assertion: " + msg);
}

Deno.test("découvrabilité — nudge valide & client-agnostique", () => {
  for (const [name, txt] of [["INSTRUCTIONS", V3_INSTRUCTIONS], ["PROMPT", RECOMMENDED_SYSTEM_PROMPT]] as const) {
    assert(txt.includes("load"), `${name} doit nudger vers load`);
    assert(txt.toLowerCase().includes("memento"), `${name} doit nommer Memento`);
    // client-agnostique : pas de nom de client
    assert(!/claude|chatgpt|gpt|mistral|gemini/i.test(txt), `${name} doit rester client-agnostique`);
    // gotcha déploiement : aucun backtick (casserait le template literal du transport)
    assert(!txt.includes("`"), `${name} ne doit contenir aucun backtick`);
  }
});
