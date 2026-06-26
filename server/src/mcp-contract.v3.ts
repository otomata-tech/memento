/**
 * Memento V3 — CONTRAT de la surface MCP (agent-first). CDC v3 §4 + ADR 0002.
 * Types seuls (zéro implémentation) : c'est le point de synchro pour le fan-out —
 * résolution, surface MCP, accès, recherche et UI compilent contre ces signatures.
 *
 * Noyau = 8 verbes. L'admin (créer org/base, doctrine…) est chargé à la demande,
 * hors noyau. Invariant : 0 inférence LLM serveur en LECTURE.
 */
import type { entityType, pageVisibility, grantMode } from "./schema.v3.ts";

type EntityType = (typeof entityType.enumValues)[number]; // personne|entreprise|outil|decision
type Visibility = (typeof pageVisibility.enumValues)[number]; // private|org|public
type Mode = (typeof grantMode.enumValues)[number]; // read|write
type Scope = "savoir" | "sources" | "both";

// ── Entités dans les réponses (NER + logique) ────────────────────────────────
export interface EntityRef {
  id: string;
  type: EntityType;
  label: string; // canonical_label
}

// ── load : l'épine (guide + arbre N+2 + entités saillantes). 0 LLM, cache-friendly ──
export interface TreeNode {
  id: string;
  title: string;
  description: string;
  children?: TreeNode[];
}
export interface LoadResult {
  guide: string; // = description de la page racine (HOW-TO + structure)
  tree: TreeNode[]; // à `depth` (défaut N+2)
  topEntities: EntityRef[];
  counts: { pages: number; entities: number; sources: number };
  etag: string;
}
export type Load = (args: { base?: string; depth?: number }) => Promise<LoadResult>;

// ── search : hybride pgvector(page_chunk)+FTS, RRF → page + passage ───────────
export interface SearchHit {
  pageId: string;
  title: string;
  description: string;
  passage: string; // assez riche pour répondre sans get dans le cas courant
  occurredAt: string | null;
  score: number;
  matchedBy: ("semantic" | "lexical")[];
  entities: EntityRef[];
}
export type Search = (args: {
  q: string;
  scope?: Scope; // défaut 'savoir'
  filters?: { page?: string; occurredFrom?: string; occurredTo?: string };
  limit?: number; // défaut 8
}) => Promise<SearchHit[]>;

// ── get : détail page|entité (+ navigation locale) ───────────────────────────
export type GetInclude = "children" | "backlinks" | "sources";
export type Get = (args: {
  id: string;
  kind: "page" | "entity";
  include?: GetInclude[];
}) => Promise<unknown>; // PageDetail | EntityDetail — affiné par chaque morceau

// ── list / count : déterministes, sous accès ─────────────────────────────────
export type ListKind = "pages" | "entities" | "sources" | "ingestions" | "entity_review";
export type List = (args: {
  kind: ListKind;
  filters?: Record<string, unknown>; // ex. entities:{type}, ingestions:{mine:true}
  cursor?: string;
  limit?: number;
}) => Promise<{ items: unknown[]; totalCount: number; cursor: string | null }>;
export type Count = (args: { kind: ListKind; filters?: Record<string, unknown> }) => Promise<{ total: number }>;

// ── propose_changes : NE MUTE RIEN → crée un item de Revue. ops réduites ──────
// Familles d'entités (ADR 0002) : NER = extraites serveur (PAS d'op ici) ;
// logique = posée par l'agent → `assert_entity` (decision en 1re).
export type ProposeOp =
  | { op: "create_page"; payload: { parentId: string | null; title: string; description: string; body?: string } }
  | { op: "update_page"; payload: { pageId: string; mode: "append" | "replace"; title?: string; description?: string; body?: string } }
  | { op: "move_page"; payload: { pageId: string; newParentId: string | null; position?: number } }
  | { op: "delete_page"; payload: { pageId: string; reason: string } }
  | { op: "attach_source"; payload: { pageId: string; source: { kind: "url" | "file" | "texte"; title: string; uri?: string; content?: string; citation?: string }; locator?: string } }
  | { op: "set_visibility"; payload: { pageId: string; visibility: Visibility } } // PROMOUVOIR perso→équipe
  // entité LOGIQUE (decision) posée par l'agent. status/occurred_at/supersedes → entity.attributes.
  | { op: "assert_entity"; payload: { type: "decision"; label: string; pageId: string; span?: string; status?: "proposee" | "actee" | "supersedee"; occurredAt?: string; supersedes?: string } }
  | { op: "merge_entities"; payload: { keep: string; drop: string } } // valide une suggestion de fusion
  | { op: "confirm_distinct"; payload: { a: string; b: string } };

export type ProposeChanges = (args: {
  title: string;
  changes: ProposeOp[];
  clientKey?: string;
}) => Promise<{ ingestionId: string; similarExisting: { pageId: string; score: number }[] }>;

// ── apply : IDEMPOTENT (lock CAS). Écrit la page, déclenche l'extraction NER async ──
export type Apply = (args: { ingestionId: string }) => Promise<{ status: string }>;

// ── share : par page (visibilité OU grant user). Pas de groupes en v1 (ADR 0003) ──
export type Share = (args: {
  pageRef: string;
  to: { visibility: Visibility } | { user: string; mode: Mode };
}) => Promise<{ ok: true }>;

// ── admin : verbe UNIQUE hors noyau (gestion org/équipe, issues #71/#31) ──────
// Un seul verbe `admin({action, …})` pour tenir le budget de surface (#31). 1 org =
// 1 base (ADR 0003) → `create_org` crée la base d'office, seul `rename_base` subsiste.
// Rôles = admin|member. `invite_member` résout l'email→sub (flux d'invitation partagé).
export type AdminArgs =
  | { action: "orgs" } // lecture : orgs de l'appelant + membres + base (alimente la vue Org)
  | { action: "create_org"; name: string; slug?: string; baseName?: string }
  | { action: "rename_base"; baseId: string; name: string }
  | { action: "invite_member"; orgSlug: string; email: string; role?: "admin" | "member" }
  | { action: "set_role"; orgSlug: string; userId: string; role: "admin" | "member" }
  | { action: "remove_member"; orgSlug: string; userId: string };
export type Admin = (args: AdminArgs) => Promise<unknown>;

// ── Le noyau (8) ─────────────────────────────────────────────────────────────
export interface McpCoreV3 {
  load: Load;
  search: Search;
  get: Get;
  list: List;
  count: Count;
  propose_changes: ProposeChanges;
  apply: Apply;
  share: Share;
}
