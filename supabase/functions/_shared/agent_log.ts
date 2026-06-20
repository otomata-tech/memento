/**
 * Agent chat log — full transcript of public "agent mode" exchanges (one row per
 * turn). Write is server-side from the agent function (best-effort, never blocks
 * the answer). Read is reserved to a KB's curators/admins, to see what people ask
 * and where the agent comes up empty (FAQ gaps). No raw IP is stored.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { agentChatLog, db } from "./db.ts";
import { assertAccess } from "./access.ts";

/** sha-256(ip + salt) hex (first 16 bytes) — correlate abuse without storing the IP.
 *  Salt from env so the hash isn't reversible by rainbow table; "" if unset. */
async function hashIp(ip: string): Promise<string | null> {
  if (!ip || ip === "unknown") return null;
  const salt = Deno.env.get("AGENT_LOG_IP_SALT") ?? "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + salt));
  return Array.from(new Uint8Array(buf).slice(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function logAgentChat(args: {
  workspace: string;
  org?: string | null;
  sub?: string | null;
  ip?: string;
  question: string;
  reply: string;
  hits?: number;
  searches?: number;
  steps?: number;
  tokens?: number;
}): Promise<void> {
  await db.insert(agentChatLog).values({
    workspaceSlug: args.workspace,
    org: args.org ?? null,
    sub: args.sub || null,
    ipHash: args.ip ? await hashIp(args.ip) : null,
    question: args.question,
    reply: args.reply,
    hits: args.hits ?? null,
    searches: args.searches ?? null,
    steps: args.steps ?? null,
    tokens: args.tokens ?? null,
  });
}

/** Recent agent exchanges for a KB — curator/admin (write access) of the KB only.
 *  `noHits: true` filters to turns where the agent found nothing (the gaps to fix). */
export async function listAgentChatLogs(
  args: { workspace: string; limit?: number; noHits?: boolean },
  sub: string,
) {
  await assertAccess(sub, { workspace: args.workspace }, { write: true });
  const conds = [eq(agentChatLog.workspaceSlug, args.workspace)];
  if (args.noHits) conds.push(sql`coalesce(${agentChatLog.hits}, 0) = 0`);

  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const [{ n: total }] = await db.select({ n: sql<number>`count(*)::int` })
    .from(agentChatLog).where(and(...conds));
  const rows = await db.select({
    id: agentChatLog.id,
    question: agentChatLog.question,
    reply: agentChatLog.reply,
    hits: agentChatLog.hits,
    searches: agentChatLog.searches,
    steps: agentChatLog.steps,
    tokens: agentChatLog.tokens,
    sub: agentChatLog.sub,
    createdAt: agentChatLog.createdAt,
  }).from(agentChatLog).where(and(...conds)).orderBy(desc(agentChatLog.createdAt)).limit(limit);

  return { count: rows.length, total: Number(total), hasMore: Number(total) > rows.length, logs: rows };
}
