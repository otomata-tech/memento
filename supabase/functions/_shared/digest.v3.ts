/**
 * V3 — Digest déterministe (#65, CDC §9). SQL pur, **0 re-résumé serveur** : renvoie
 * le *delta* d'une org sur une fenêtre (pages récentes, décisions récentes & ouvertes,
 * révisions). L'agent (host) habille le narratif ; le serveur ne fait que requêter.
 *
 * Scopé org (1 base/org). Import db paresseux (convention v3) → charge sans DATABASE_URL.
 */
import { sql } from "drizzle-orm";

let _db: typeof import("./db.v3.ts").db | null = null;
async function getDb() {
  if (!_db) _db = (await import("./db.v3.ts")).db;
  return _db;
}

export interface Digest {
  orgId: string;
  sinceDays: number;
  recentPages: { id: string; title: string; description: string; updatedAt: string }[];
  recentDecisions: { id: string; label: string; status: string | null; occurredAt: string | null }[];
  openDecisions: { id: string; label: string }[]; // décisions « proposee » non encore actées
  revisions: { targetType: string; op: string; actor: string; at: string }[];
}

/** Delta de l'org sur les `sinceDays` derniers jours (défaut 7). Lecture seule, déterministe. */
export async function runDigest(orgId: string, opts: { sinceDays?: number } = {}): Promise<Digest> {
  const sinceDays = opts.sinceDays ?? 7;
  const db = await getDb();
  const since = sql`now() - make_interval(days => ${sinceDays})`;

  const recentPages = await db.execute<{ id: string; title: string; description: string; updated_at: string }>(sql`
    select p.id, p.title, p.description, p.updated_at
    from mem_pages p join mem_bases b on b.id = p.base_id
    where b.org_id = ${orgId} and p.status = 'active'
      and (p.updated_at >= ${since} or (p.occurred_at is not null and p.occurred_at >= ${since}))
    order by coalesce(p.occurred_at, p.updated_at) desc limit 50`);

  const recentDecisions = await db.execute<{ id: string; label: string; status: string | null; occurred_at: string | null }>(sql`
    select id, canonical_label as label, attributes->>'status' as status, attributes->>'occurred_at' as occurred_at
    from mem_entities
    where org_id = ${orgId} and type = 'decision' and created_at >= ${since}
    order by created_at desc limit 50`);

  const openDecisions = await db.execute<{ id: string; label: string }>(sql`
    select id, canonical_label as label from mem_entities
    where org_id = ${orgId} and type = 'decision' and attributes->>'status' = 'proposee'
    order by created_at desc limit 50`);

  const revisions = await db.execute<{ target_type: string; op: string; actor: string; created_at: string }>(sql`
    select r.target_type, r.op, r.actor, r.created_at
    from mem_revisions r join mem_bases b on b.id = r.base_id
    where b.org_id = ${orgId} and r.created_at >= ${since}
    order by r.created_at desc limit 100`);

  return {
    orgId, sinceDays,
    recentPages: recentPages.map((p) => ({ id: p.id, title: p.title, description: p.description, updatedAt: String(p.updated_at) })),
    recentDecisions: recentDecisions.map((d) => ({ id: d.id, label: d.label, status: d.status, occurredAt: d.occurred_at })),
    openDecisions: [...openDecisions],
    revisions: revisions.map((r) => ({ targetType: r.target_type, op: r.op, actor: r.actor, at: String(r.created_at) })),
  };
}
