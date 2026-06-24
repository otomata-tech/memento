/**
 * Memento V3 — accès PAR PAGE (ADR 0003, issue #56). Le choke-point applicatif.
 *
 * Modèle (≠ v2 par-workspace de `access.ts`, gardé intact pour la v2 live) :
 *  - 3 visibilités par page : private · org · public ; + grants user (read|write) ;
 *  - HÉRITAGE dans l'arbre, nearest-explicit-wins ; `public` jamais hérité.
 *
 * SOURCE UNIQUE de la résolution = les fonctions SQL de la migration
 * `*_v3_fine_access.sql` (`page_read_mode` → `is_page_accessible` / `page_can_write`
 * / `accessible_page_ids`). On NE réimplémente PAS la règle d'accès en TS
 * (derive don't duplicate) : ce fichier ne fait que (a) poser l'identité de
 * l'appelant et (b) traduire un refus en `AccessError`.
 *
 * Identité : les prédicats SQL lisent `mem_current_sub()` (= request.jwt.claims).
 * Le runtime se connecte en PROPRIÉTAIRE (il CONTOURNE la RLS) → il doit POSER
 * lui-même l'identité avant d'appeler les prédicats : c'est `withCurrentSub`.
 * Le MÊME `is_page_accessible` arme la policy RLS de `mem_pages` ET le WHERE de
 * `search` → zéro divergence possible.
 */
import { sql } from "drizzle-orm";
// db chargé paresseusement : importer ce module ne doit PAS exiger DATABASE_URL
// (aligné sur entities.ts) → toute la surface v3 reste importable/testable sans DB.
type Db = typeof import("./db.ts").db;
let _db: Db | null = null;
async function getDb(): Promise<Db> {
  if (!_db) _db = (await import("./db.ts")).db;
  return _db;
}

export class AccessError extends Error {}

/** Message indistinct : « introuvable » et « interdit » donnent la MÊME réponse,
 *  pour ne pas faire de l'erreur un oracle d'existence cross-tenant. */
const NOT_FOUND_OR_FORBIDDEN = "resource not found or access denied";

/** Masque les erreurs du driver Postgres (SQLSTATE/severity) qui révéleraient le
 *  schéma ; laisse passer les erreurs applicatives intentionnelles. */
export function safeErrorMessage(e: unknown): string {
  const anyE = e as { code?: unknown; severity?: unknown };
  const looksLikeDbError =
    (typeof anyE?.code === "string" && /^[0-9A-Z]{5}$/.test(anyE.code)) ||
    typeof anyE?.severity === "string";
  if (looksLikeDbError) return "internal error";
  return e instanceof Error ? e.message : String(e);
}

/**
 * Exécute `fn` avec `request.jwt.claims` positionné sur {sub} le temps d'UNE
 * transaction (set_config local) → les prédicats SQL voient l'appelant. Local =
 * jamais de fuite d'identité d'une requête sur la suivante via le pool.
 */
export async function withCurrentSub<T>(sub: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return (await getDb()).transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: sub ?? "" })}, true)`);
    return fn(tx as unknown as Db);
  });
}

export type PageMode = "read" | "write" | null;

/** Mode effectif (read|write|null) d'une page pour `sub` — dérivé de page_read_mode. */
export async function pageReadMode(sub: string, pageId: string): Promise<PageMode> {
  return withCurrentSub(sub, async (tx) => {
    const r = await tx.execute(sql`select page_read_mode(${pageId}::uuid) as mode`);
    return ((r as unknown as { mode: PageMode }[])[0]?.mode ?? null);
  });
}

/** Page LISIBLE (accessible/héritée OU publique par lien) — le prédicat de search/RLS. */
export async function isPageAccessible(sub: string, pageId: string): Promise<boolean> {
  return withCurrentSub(sub, async (tx) => {
    const r = await tx.execute(sql`select is_page_accessible(${pageId}::uuid) as ok`);
    return (r as unknown as { ok: boolean }[])[0]?.ok === true;
  });
}

/** Page ÉNUMÉRABLE (membership/grant/owner/héritage) — SANS le public-par-lien :
 *  le prédicat de search/list (#57). is_page_accessible (public inclus) = get/RLS. */
export async function isPageEnumerable(sub: string, pageId: string): Promise<boolean> {
  return withCurrentSub(sub, async (tx) => {
    const r = await tx.execute(sql`select is_page_enumerable(${pageId}::uuid) as ok`);
    return (r as unknown as { ok: boolean }[])[0]?.ok === true;
  });
}

/** Autorité d'ÉCRITURE (mode effectif = write). */
export async function pageCanWrite(sub: string, pageId: string): Promise<boolean> {
  return withCurrentSub(sub, async (tx) => {
    const r = await tx.execute(sql`select page_can_write(${pageId}::uuid) as ok`);
    return (r as unknown as { ok: boolean }[])[0]?.ok === true;
  });
}

/** Ensemble énumérable des pages lisibles par `sub` (filtre de list/load). */
export async function accessiblePageIds(sub: string): Promise<string[]> {
  return withCurrentSub(sub, async (tx) => {
    const r = await tx.execute(sql`select id from mem_pages where id in (select accessible_page_ids())`);
    return (r as unknown as { id: string }[]).map((x) => x.id);
  });
}

/** Base accessible (membre de l'org) ? — garde de load/search au niveau base. */
export async function isBaseAccessible(sub: string, baseId: string): Promise<boolean> {
  return withCurrentSub(sub, async (tx) => {
    const r = await tx.execute(sql`select ${baseId}::uuid in (select accessible_base_ids()) as ok`);
    return (r as unknown as { ok: boolean }[])[0]?.ok === true;
  });
}

// ── LE choke-point ────────────────────────────────────────────────────────────
export type AccessRef = { pageId: string } | { baseId: string };

/**
 * Garde l'accès à la ressource ciblée. Lecture par défaut ; `write` exige le mode
 * effectif `write`. Lève toujours le MÊME message indistinct sur refus de lecture.
 *
 *  - lecture page : `is_page_accessible` (public-par-lien inclus).
 *  - écriture page : `page_can_write`.
 *  - base (load/search) : `accessible_base_ids` (membre de l'org).
 *
 * Les verbes d'ÉNUMÉRATION (search/list/load) filtrent EN PLUS leur SELECT par
 * `is_page_accessible`/`accessible_page_ids` (cf. la migration) ; ce garde couvre
 * le niveau base + les accès ponctuels (get) et toutes les écritures.
 */
export async function assertAccess(sub: string, ref: AccessRef, opts?: { write?: boolean }): Promise<void> {
  if ("baseId" in ref) {
    if (!(await isBaseAccessible(sub, ref.baseId))) throw new AccessError(NOT_FOUND_OR_FORBIDDEN);
    return;
  }
  if (opts?.write) {
    if (!(await pageCanWrite(sub, ref.pageId))) {
      // accessible en lecture mais pas en écriture vs carrément invisible : même
      // message si invisible (oracle), message d'écriture si seulement lecture.
      if (await isPageAccessible(sub, ref.pageId)) throw new AccessError("writing restricted: read-only access to this page");
      throw new AccessError(NOT_FOUND_OR_FORBIDDEN);
    }
    return;
  }
  if (!(await isPageAccessible(sub, ref.pageId))) throw new AccessError(NOT_FOUND_OR_FORBIDDEN);
}

// ── Publication (set_visibility) = geste sensible (ADR 0003 §3) ────────────────
/**
 * Vrai si le changement de visibilité est SENSIBLE (élargit le partage : passage
 * à public, ou private→org). La surface (verbe) doit alors faire CONFIRMER l'agent
 * avant d'appliquer — anti-modification/publication accidentelle.
 */
export function isSensitivePublication(newVisibility: string, oldVisibility: string): boolean {
  const rank: Record<string, number> = { private: 0, org: 1, public: 2 };
  return (rank[newVisibility] ?? 0) > (rank[oldVisibility] ?? 0);
}

/**
 * Garde `set_visibility`. Écriture requise sur la page ; PUBLIER (public) est plus
 * sensible → réservé au proprio de la page ou à un admin de l'org propriétaire.
 *
 * NB (décision à valider) : on borne la publication à owner|org_admin. Si l'on veut
 * que tout membre en write puisse publier, retirer le bloc `public`.
 */
export async function assertCanSetVisibility(sub: string, pageId: string, newVisibility: string): Promise<void> {
  if (!(await pageCanWrite(sub, pageId))) {
    if (await isPageAccessible(sub, pageId)) throw new AccessError("writing restricted: read-only access to this page");
    throw new AccessError(NOT_FOUND_OR_FORBIDDEN);
  }
  if (newVisibility === "public") {
    const ok = await withCurrentSub(sub, async (tx) => {
      const r = await tx.execute(sql`
        select exists (
          select 1 from mem_pages p where p.id = ${pageId}::uuid and p.owner_id = mem_current_sub()
        ) or exists (
          select 1 from mem_pages p
            join mem_bases b on b.id = p.base_id
            join mem_memberships m on m.org_id = b.org_id and m.user_id = mem_current_sub()
          where p.id = ${pageId}::uuid and m.role = 'admin'
        ) as ok`);
      return (r as unknown as { ok: boolean }[])[0]?.ok === true;
    });
    if (!ok) throw new AccessError("publishing (public) restricted to the page owner or an org admin");
  }
}
