/**
 * Memento V3 — onboarding : provisionne org perso + base + membership au premier
 * accès d'un compte sans tenant (issue #70). Sans ça, un nouvel inscrit n'a AUCUNE
 * org → `v3Bases` (INNER JOIN sur memberships) renvoie [] → viewer vide, cul-de-sac.
 *
 * Port du `ensureDefaultWorkspace`/`ensurePersonalOrg` v2 (`admin.ts`) vers le schéma
 * v3 « base » (workspace→base, 1 base/org — ADR 0003 ; PAS de workspace-grant : en v3
 * l'accès vient de la PAGE). Idempotent ; ne provisionne QUE si l'appelant n'a aucune
 * base accessible (un user migré 4As/otomata-business a déjà son org → no-op exact).
 *
 * Appelé AVANT (jamais DANS) le `withCurrentSub` des verbes topologiques (v3Bases,
 * v3Load) → transactions séquentielles, pas d'imbrication. Le runtime se connecte en
 * PROPRIÉTAIRE des tables (il contourne la RLS, cf. 0005_enable_rls.sql) → les inserts
 * dans mem_orgs/mem_bases/mem_memberships passent.
 */
import { sql } from "drizzle-orm";
import { withCurrentSub } from "./access.v3.ts";
import { slugify } from "./write.ts";

const one = <T>(r: unknown) => (r as unknown as T[])[0];
const rows = <T>(r: unknown) => r as unknown as T[];

/**
 * Garantit que `sub` est membre d'au moins une org dotée d'une base. No-op si une base
 * lui est déjà accessible (même condition exacte que le `[]` de v3Bases) ou si `sub` est
 * vide (anonyme). Sinon crée : org perso (`personal_for=sub`) + membership admin + base.
 */
export async function ensurePersonalBaseV3(sub: string): Promise<void> {
  if (!sub) return; // anonyme = no-op
  await withCurrentSub(sub, async (tx) => {
    // Déjà ≥1 base accessible (membre d'une org qui a une base) ? → rien à faire.
    // MÊME jointure que v3Bases : c'est la condition exacte du « viewer vide ».
    const has = one<{ ok: number }>(await tx.execute(sql`
      select 1 as ok from mem_bases b
      join mem_memberships m on m.org_id = b.org_id and m.user_id = ${sub} limit 1`));
    if (has) return;

    // Slug org lisible dérivé de l'email, dédupliqué (le slug est UNIQUE, indépendant de
    // personal_for). Fenêtre de course ténue (2 users, même local-part, même instant)
    // assumée comme en v2.
    const email = one<{ email: string }>(await tx.execute(
      sql`select email from auth.users where id::text = ${sub}`))?.email ?? "perso";
    const local = email.split("@")[0] || "perso";
    const wanted = slugify(`perso-${local}`);
    const taken = new Set(rows<{ slug: string }>(await tx.execute(
      sql`select slug from mem_orgs where slug = ${wanted} or slug like ${wanted + "-%"}`)).map((r) => r.slug));
    let slug = wanted;
    if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }

    // org perso : `on conflict (personal_for) do update … returning` renvoie la ligne MÊME
    // si une requête concurrente vient de la créer (do nothing ne renverrait rien).
    const orgId = one<{ id: string }>(await tx.execute(sql`
      insert into mem_orgs (slug, name, personal_for)
      values (${slug}, ${`Personal (${local})`}, ${sub})
      on conflict (personal_for) do update set personal_for = excluded.personal_for
      returning id`)).id;
    await tx.execute(sql`
      insert into mem_memberships (org_id, user_id, role) values (${orgId}, ${sub}, 'admin')
      on conflict do nothing`);
    await tx.execute(sql`
      insert into mem_bases (org_id, name) values (${orgId}, 'My knowledge base')
      on conflict (org_id) do nothing`);
  });
}
