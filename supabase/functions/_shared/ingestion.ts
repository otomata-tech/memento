/**
 * Propose-validate loop (Batch 5). Cf. spec §5.4 / §6.
 *
 * An agent proposes a change-set (`stage_changes`) → `MemIngestion` PROPOSED, nothing is mutated.
 * A human reviews (`get`/`list`) then applies all or a subset (`apply`) or rejects
 * (`reject`). On application, each op executes the corresponding write verb and logs
 * a `MemRevision` linked to the `ingestionId` (reversible via before/after).
 *
 * Guardrail: a CONTRADICT-class op is NEVER auto-applied — it must be accepted
 * explicitly via `acceptIds`. Scoping guardrail: each op's target must belong to the
 * ingestion's workspace (no cross-workspace mutation via a forged change-set).
 *
 * Each change's state (applied/error) is persisted in the `proposal` jsonb: a PARTIAL
 * ingestion can be re-applied to process the remaining ops.
 */
import { and, desc, eq, isNull, lt, notInArray, or } from "drizzle-orm";
import { db, ingestions, workspaces } from "./db.ts";
import { loopUrl } from "./urls.ts";
import { resolveWorkspaceId } from "./access.ts";
import { nearDuplicates } from "./semantic.ts";
import {
  addDocument, addBlock, updateBlock, setBlockType, deleteBlock,
  attachSource, detachSource, verifyBlock, moveBlock, linkBlocks, unlinkBlocks, deprecateDocument,
  type WriteCtx,
} from "./write.ts";

const CLASSES = ["CONFIRM", "ENRICH", "CONTRADICT", "OBSOLETE"];

type Handler = (payload: any, actor: string, ctx: WriteCtx) => Promise<any>;
const OPS: Record<string, Handler> = {
  add_document: addDocument, add_block: addBlock, update_block: updateBlock,
  set_block_type: setBlockType, delete_block: deleteBlock,
  attach_source: attachSource, detach_source: detachSource,
  verify_block: verifyBlock, move_block: moveBlock,
  link_blocks: linkBlocks, unlink: unlinkBlocks, deprecate_document: deprecateDocument,
};

// Primary target of each op → to check that it lives in the ingestion's workspace.
const TARGET: Record<string, { kind: "section" | "document" | "block" | "link"; field: string }> = {
  add_document: { kind: "section", field: "sectionId" },
  add_block: { kind: "document", field: "documentId" },
  update_block: { kind: "block", field: "id" },
  set_block_type: { kind: "block", field: "id" },
  delete_block: { kind: "block", field: "id" },
  verify_block: { kind: "block", field: "id" },
  attach_source: { kind: "block", field: "blockId" },
  detach_source: { kind: "block", field: "blockId" },
  move_block: { kind: "block", field: "id" },
  link_blocks: { kind: "block", field: "fromId" },
  unlink: { kind: "link", field: "linkId" },
  deprecate_document: { kind: "document", field: "id" },
};

type Feedback = { author: string; authorKind: string; body: string; at: string };
type Change = {
  id: string; op: string; class: string;
  target: string | null; rationale: string | null; payload: Record<string, unknown>;
  applied: boolean; appliedAt?: string; error?: string;
  feedback?: Feedback[]; // human review feedback (ping-pong); read by the agent on the next round
  edited?: boolean; editedBy?: string; // payload tweaked by a human before application
};

// Asserts the op's primary target lives in the ingestion's workspace. The id lives in
// `payload[field]`, NOT the descriptive top-level `target` label. Distinguishes the three
// failure modes — missing/misnamed field, unknown id, genuine cross-workspace — instead of
// the blanket "target outside the ingestion's workspace" that hid all of them (the #1 footgun:
// ids put in `target`, or fields named `text`/`blockId` instead of `content`/`id`).
async function assertTargetInWorkspace(
  op: string, payload: Record<string, unknown>, workspaceId: string,
): Promise<void> {
  const t = TARGET[op];
  if (!t) return;
  const id = payload[t.field];
  if (typeof id !== "string" || !id) {
    throw new Error(
      `${op}: missing \`${t.field}\` in payload (operational ids go in payload, not the ` +
      `descriptive top-level \`target\` label).`,
    );
  }
  const wsId = await resolveWorkspaceId({ id, kind: t.kind });
  if (wsId === null) throw new Error(`${op}: ${t.kind} \`${id}\` not found (\`${t.field}\`).`);
  if (wsId !== workspaceId) {
    throw new Error(`${op}: ${t.kind} \`${id}\` belongs to another workspace — cross-workspace mutation refused.`);
  }
}

function counts(changes: Change[]) {
  const byClass: Record<string, number> = {};
  let applied = 0, pending = 0, errored = 0;
  for (const c of changes) {
    byClass[c.class] = (byClass[c.class] ?? 0) + 1;
    if (c.applied) applied++; else pending++;
    if (c.error) errored++;
  }
  return { total: changes.length, applied, pending, errored, byClass };
}

function present(row: typeof ingestions.$inferSelect, slug?: string) {
  const changes = (row.proposal as Change[]) ?? [];
  return {
    id: row.id, workspace: slug, workspaceId: row.workspaceId,
    url: slug ? loopUrl(slug, row.id) : null,
    title: row.title, summary: row.summary, status: row.status,
    reviewNote: row.reviewNote ?? null,
    sourceId: row.sourceId, createdBy: row.createdBy, createdAt: row.createdAt,
    decidedBy: row.decidedBy, decidedAt: row.decidedAt,
    counts: counts(changes), changes,
  };
}

// Validates the ops/classes and materializes the changes (stable id per change).
function buildChanges(input: Array<{ op: string; class?: string; target?: string; rationale?: string; payload?: Record<string, unknown> }>): Change[] {
  return input.map((c) => {
    if (!OPS[c.op]) throw new Error(`unknown op: ${c.op} (expected: ${Object.keys(OPS).join(", ")})`);
    if (c.class && !CLASSES.includes(c.class)) throw new Error(`invalid class: ${c.class} (expected: ${CLASSES.join(", ")})`);
    return {
      id: crypto.randomUUID(), op: c.op, class: c.class ?? "ENRICH",
      target: c.target ?? null, rationale: c.rationale ?? null,
      payload: c.payload ?? {}, applied: false,
    };
  });
}

// ── Verbs ─────────────────────────────────────────────────────────────────────
export async function stageChanges(
  args: {
    workspace: string; sourceId?: string; title: string; summary?: string; clientKey?: string;
    changes: Array<{ op: string; class?: string; target?: string; rationale?: string; payload?: Record<string, unknown> }>;
  },
  actor: string,
) {
  const [ws] = await db.select({ id: workspaces.id, slug: workspaces.slug }).from(workspaces)
    .where(eq(workspaces.slug, args.workspace)).limit(1);
  if (!ws) throw new Error(`Workspace not found: ${args.workspace}`);
  if (!args.changes?.length) throw new Error("`changes` is empty");

  // Idempotence (#44) + supersession (ping-pong): same clientKey, same workspace.
  if (args.clientKey) {
    const [dup] = await db.select().from(ingestions)
      .where(and(eq(ingestions.workspaceId, ws.id), eq(ingestions.clientKey, args.clientKey))).limit(1);
    if (dup) {
      // Closed (APPLIED/REJECTED) → idempotent no-op (safe retry).
      if (dup.status === "APPLIED" || dup.status === "REJECTED") {
        return { ...present(dup, ws.slug), deduplicated: true };
      }
      // Open (PROPOSED/PARTIAL/CHANGES_REQUESTED) → the agent re-proposes after review:
      // we replace the change-set, reopen as PROPOSED and clear the decision state.
      const next = buildChanges(args.changes);
      const [upd] = await db.update(ingestions).set({
        title: args.title, summary: args.summary ?? "", sourceId: args.sourceId ?? dup.sourceId,
        proposal: next, status: "PROPOSED", reviewNote: null, decidedBy: null, decidedAt: null,
      }).where(eq(ingestions.id, dup.id)).returning();
      return { ...present(upd, ws.slug), superseded: true };
    }
  }

  const changes = buildChanges(args.changes);

  const [row] = await db.insert(ingestions).values({
    workspaceId: ws.id, sourceId: args.sourceId ?? null, title: args.title,
    summary: args.summary ?? "", proposal: changes, status: "PROPOSED", createdBy: actor,
    clientKey: args.clientKey ?? null,
  }).onConflictDoNothing({ target: [ingestions.workspaceId, ingestions.clientKey] }).returning();
  if (!row) return stageChanges(args, actor); // lost the check/insert race → re-read the existing one

  // Anti-duplicate signal (#44), best-effort: for each proposed add_block, the near-identical
  // blocks already in the database. The server signals, the agent and reviewer judge.
  const dupChecks = await Promise.all(
    changes
      .filter((c) => c.op === "add_block" && typeof c.payload.content === "string")
      .slice(0, 20)
      .map(async (c) => ({
        changeId: c.id,
        similar: await nearDuplicates(ws.id, { text: c.payload.content as string }),
      })),
  );
  const similarExisting = dupChecks.filter((d) => d.similar.length);
  return { ...present(row, ws.slug), ...(similarExisting.length ? { similarExisting } : {}) };
}

async function fetchWithSlug(id: string) {
  const [row] = await db.select().from(ingestions).where(eq(ingestions.id, id)).limit(1);
  if (!row) throw new Error(`Ingestion not found: ${id}`);
  const [ws] = await db.select({ slug: workspaces.slug }).from(workspaces)
    .where(eq(workspaces.id, row.workspaceId)).limit(1);
  return { row, slug: ws?.slug };
}

export async function getIngestion(id: string) {
  const { row, slug } = await fetchWithSlug(id);
  return present(row, slug);
}

export async function listIngestions(args: { workspace: string; status?: string }) {
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces)
    .where(eq(workspaces.slug, args.workspace)).limit(1);
  if (!ws) throw new Error(`Workspace not found: ${args.workspace}`);
  const conds = [eq(ingestions.workspaceId, ws.id)];
  if (args.status) conds.push(eq(ingestions.status, args.status as any));
  const rows = await db.select().from(ingestions).where(and(...conds)).orderBy(desc(ingestions.createdAt));
  return {
    workspace: args.workspace, count: rows.length,
    ingestions: rows.map((r) => ({
      id: r.id, url: loopUrl(args.workspace, r.id),
      title: r.title, status: r.status, sourceId: r.sourceId,
      createdBy: r.createdBy, createdAt: r.createdAt, counts: counts((r.proposal as Change[]) ?? []),
    })),
  };
}

export async function applyIngestion(
  args: { id: string; acceptIds?: string[]; edits?: Array<{ id: string; payload: Record<string, unknown> }> },
  actor: string,
) {
  // Atomic claim (#40): reserves the ingestion BEFORE any work. A single UPDATE
  // wins the race; a concurrent or replayed apply (in-flight transport retry)
  // gets 0 rows → idempotent no-op, no double execution of the change-set.
  const claimCutoff = new Date(Date.now() - 5 * 60_000); // older claim = crashed apply → reopenable
  const [claimed] = await db.update(ingestions)
    .set({ claimedAt: new Date() })
    .where(and(
      eq(ingestions.id, args.id),
      notInArray(ingestions.status, ["APPLIED", "REJECTED"]),
      or(isNull(ingestions.claimedAt), lt(ingestions.claimedAt, claimCutoff)),
    ))
    .returning({ id: ingestions.id });
  if (!claimed) {
    // Already closed, or another apply holds the claim → no-op, we return the current state.
    const { row, slug } = await fetchWithSlug(args.id);
    return {
      id: args.id, workspace: slug, status: row.status,
      counts: counts((row.proposal as Change[]) ?? []), results: [], noop: true,
    };
  }
  const { row, slug } = await fetchWithSlug(args.id);
  const changes = (row.proposal as Change[]) ?? [];
  const accept = args.acceptIds ? new Set(args.acceptIds) : null;
  const edits = new Map((args.edits ?? []).map((e) => [e.id, e.payload]));
  const results: Array<{ id: string; status: string; reason?: string; error?: string }> = [];

  for (const c of changes) {
    if (c.applied) { results.push({ id: c.id, status: "already" }); continue; }
    if (accept && !accept.has(c.id)) { results.push({ id: c.id, status: "skipped" }); continue; }
    // CONTRADICT never auto-applied: requires explicit acceptance by id.
    if (c.class === "CONTRADICT" && !(accept && accept.has(c.id))) {
      results.push({ id: c.id, status: "held", reason: "CONTRADICT requires explicit acceptance (acceptIds)" });
      continue;
    }
    // In-place human edit: we merge the tweaked payload before executing the op
    // (so the MemRevision tracks the validated content, not the agent's raw proposal).
    const edit = edits.get(c.id);
    if (edit) { c.payload = { ...c.payload, ...edit }; c.edited = true; c.editedBy = actor; }
    try {
      await assertTargetInWorkspace(c.op, c.payload, row.workspaceId);
      // Thread the change's rationale as the revision `reason` when the payload omits one, so the
      // audit log records *why* the op ran (and never an empty reason). An explicit payload.reason
      // wins; revise() still backstops a fully-absent reason.
      const opArgs = ("reason" in c.payload) || !c.rationale ? c.payload : { ...c.payload, reason: c.rationale };
      await OPS[c.op](opArgs, actor, { ingestionId: row.id });
      c.applied = true; c.appliedAt = new Date().toISOString(); delete c.error;
      results.push({ id: c.id, status: "applied" });
    } catch (e) {
      c.error = e instanceof Error ? e.message : String(e);
      results.push({ id: c.id, status: "error", error: c.error });
    }
  }

  const status = changes.some((c) => !c.applied) ? "PARTIAL" : "APPLIED";
  await db.update(ingestions)
    // claimedAt: null → releases the lock (#40); a legitimate re-apply of a PARTIAL can resume.
    .set({ proposal: changes, status, decidedBy: actor, decidedAt: new Date(), claimedAt: null })
    .where(eq(ingestions.id, args.id));
  return { id: args.id, workspace: slug, status, counts: counts(changes), results };
}

export async function rejectIngestion(args: { id: string; reason?: string }, actor: string) {
  const { row } = await fetchWithSlug(args.id);
  if (row.status === "APPLIED" || row.status === "REJECTED") {
    throw new Error(`ingestion already closed (${row.status})`);
  }
  await db.update(ingestions)
    .set({ status: "REJECTED", decidedBy: actor, decidedAt: new Date() })
    .where(eq(ingestions.id, args.id));
  return { id: args.id, status: "REJECTED", reason: args.reason ?? null };
}

/**
 * Sends an ingestion back to the agent for revision (review ping-pong). Attaches human
 * feedback per change (`items[].changeId`) and/or a global note (`note` or items without
 * a changeId), and moves to CHANGES_REQUESTED. The agent re-reads via get/list then
 * re-proposes with the same `clientKey` (→ supersession). Nothing is mutated in the KB.
 */
export async function requestChanges(
  args: { id: string; note?: string; items?: Array<{ changeId?: string; body: string }> },
  actor: string,
) {
  const { row, slug } = await fetchWithSlug(args.id);
  if (row.status === "APPLIED" || row.status === "REJECTED") {
    throw new Error(`ingestion already closed (${row.status})`);
  }
  const changes = (row.proposal as Change[]) ?? [];
  const at = new Date().toISOString();
  const items = args.items ?? [];
  let attached = 0;
  for (const it of items) {
    if (!it.body?.trim() || !it.changeId) continue;
    const target = changes.find((c) => c.id === it.changeId);
    if (!target) continue; // unknown changeId → silently ignored
    (target.feedback ??= []).push({ author: actor, authorKind: "human", body: it.body.trim(), at });
    attached++;
  }
  // Global note = `note` + any item without a changeId.
  const general = [
    ...(args.note?.trim() ? [args.note.trim()] : []),
    ...items.filter((it) => !it.changeId && it.body?.trim()).map((it) => it.body.trim()),
  ];
  if (!attached && !general.length) throw new Error("no feedback provided (note or items)");
  const reviewNote = general.length ? general.join("\n\n") : row.reviewNote;
  await db.update(ingestions)
    .set({ proposal: changes, reviewNote, status: "CHANGES_REQUESTED", decidedBy: actor, decidedAt: new Date() })
    .where(eq(ingestions.id, args.id));
  return { ...present((await fetchWithSlug(args.id)).row, slug), requested: attached, hasNote: general.length > 0 };
}
