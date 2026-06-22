// Block presentation helpers (ported from the "faithful editorial" design).
// Color semantics of types = the language, not the style → constant.
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { Block } from "../api";

/** Visual role per block type (yellow=normative, blue=definition, green=practical, red=guardrail). */
export const TYPE_ROLE: Record<string, string> = {
  PRINCIPE: "primary", REGLE: "primary",
  DEFINITION: "accent", QUESTION: "accent",
  PROCEDURE: "strong", EXEMPLE: "strong", PROMPT_PORTEUR: "strong", PROMPT_SYSTEME: "strong",
  MISE_EN_GARDE: "weak", EXCEPTION: "weak",
  PROSE: "mute",
};
export const roleClass = (type: string): string => "role-" + (TYPE_ROLE[type] ?? "mute");

export const RELLABEL: Record<string, string> = {
  CONTRADICTS: "contradicts", SUPERSEDES: "supersedes", DEPENDS_ON: "depends on", REFERENCES: "references",
};
export const RELGLYPH: Record<string, string> = {
  CONTRADICTS: "⚡", SUPERSEDES: "⇡", DEPENDS_ON: "⇠", REFERENCES: "→",
};
/** Accent class for a relation (red for the precious cases, blue for the supports). */
export const relClass = (rel: string): string =>
  rel === "CONTRADICTS" || rel === "SUPERSEDES" ? "warn"
    : rel === "REFERENCES" || rel === "DEPENDS_ON" ? "accent" : "";

/** Trust mark: [css class, label]. */
export function trustMark(b: Pick<Block, "verifiedAt" | "sources">): [string, string] {
  if (b.verifiedAt) return ["ok", "✓ verified"];
  return b.sources.length ? ["", "○ unverified"] : ["no", "⚠ no source"];
}

/** Sanitized markdown rendering (scraped content → untrusted). Identical to DocumentPane. */
export function renderMd(md: string): string {
  // `breaks: true` → a single newline renders as <br> (GFM-style), what authors expect;
  // otherwise a numbered list written line-by-line collapses onto one line.
  return DOMPurify.sanitize(marked.parse(md ?? "", { async: false, breaks: true }) as string);
}

/** Only allows safe schemes for a source href. */
export function safeHref(u: string | null | undefined): string | undefined {
  return u && /^(https?:|mailto:|\/)/i.test(u) ? u : undefined;
}

export interface Neighbour { rel: string; otherId: string; note: string | null }

/**
 * Neighbours of a block grouped by relation (dedup of symmetric links).
 * Combines outgoing links (linksFrom→toBlockId) and incoming links (linksTo→fromBlockId).
 */
export function neighbours(center: Block): Record<string, Neighbour[]> {
  const all: Neighbour[] = [
    ...center.linksFrom.map((l) => ({ rel: l.relation, otherId: l.toBlockId!, note: l.note })),
    ...center.linksTo.map((l) => ({ rel: l.relation, otherId: l.fromBlockId!, note: l.note })),
  ].filter((n) => n.otherId);
  const by: Record<string, Neighbour[]> = {};
  const seen = new Set<string>();
  for (const n of all) {
    const k = n.rel + ":" + n.otherId;
    if (seen.has(k)) continue;
    seen.add(k);
    (by[n.rel] ??= []).push(n);
  }
  return by;
}
