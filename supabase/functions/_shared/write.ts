/**
 * Curated writes (Batch 2) — mutating verbs at the block/document granularity. Every
 * mutation requires a `reason` and logs a `MemRevision` (before/after). Cf. spec §5.2.
 *
 * Authorization (admin/curator member of the owning org) is checked upstream by the
 * handlers via assertAccess(..., { write: true }).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { embedBlocks, nearDuplicates } from "./semantic.ts";
import { db, documents, blocks, sections, revisions, sources, blockSources, links, comments } from "./db.ts";
import { workspaceIdForTarget } from "./access.ts";

/** Optional write context: links the revision to an ingestion (Batch 5). */
export type WriteCtx = { ingestionId?: string };

// ── Helpers ───────────────────────────────────────────────────────────────────
export function slugify(input: string, max = 60): string {
  const s = input
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return s || "doc";
}

/** Splits markdown into PROSE blocks (merged paragraphs, bounded size). */
function splitMarkdown(text: string, maxChars = 1500, maxBlocks = 40): string[] {
  const paras = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length + 2 > maxChars) { out.push(buf); buf = p; }
    else buf = buf ? `${buf}\n\n${p}` : p;
    if (out.length >= maxBlocks) break;
  }
  if (buf && out.length < maxBlocks) out.push(buf);
  return out;
}

async function nextPosition(table: "documents" | "blocks", parentCol: string, parentId: string): Promise<number> {
  const t = table === "documents" ? documents : blocks;
  const col = table === "documents" ? documents.sectionId : blocks.documentId;
  void parentCol;
  const [r] = await db.select({ m: sql<number>`coalesce(max(position), -1)` }).from(t).where(eq(col, parentId));
  return Number(r?.m ?? -1) + 1;
}

async function sectionWorkspace(sectionId: string): Promise<string> {
  const [s] = await db.select({ ws: sections.workspaceId }).from(sections).where(eq(sections.id, sectionId)).limit(1);
  if (!s) throw new Error(`Section not found: ${sectionId}`);
  return s.ws;
}

export async function revise(
  workspaceId: string, targetType: string, targetId: string | null, op: string,
  reason: string, actor: string, before: unknown, after: unknown,
  ingestionId?: string,
): Promise<void> {
  // `before`/`after` are jsonb-nullable. A bare JS null reaches postgres-js (prepare:false,
  // Supavisor pooler) as an untyped parameter → Postgres "could not determine data type" → the
  // whole INSERT fails. This bit delete_block (its `after` is null): the block row was already
  // deleted by the caller, then this revision INSERT threw, losing the audit trail. Cast
  // explicitly so a null is typed jsonb.
  const jsonb = (v: unknown) => v == null ? sql`null::jsonb` : sql`${JSON.stringify(v)}::jsonb`;
  // `reason` is NOT NULL with no DB default. A verb applied from an ingestion whose payload
  // carries no `reason` (update_block/move_block/delete_block/set_block_type/deprecate_document
  // pass `args.reason` with no fallback) lets `undefined` reach here → drizzle renders the column
  // as DEFAULT → not-null violation. The INSERT then fails *after* the caller already mutated the
  // row (non-atomic) → silent data change reported as "errored". Backstop it so no write verb can
  // ever trip the constraint.
  const safeReason = typeof reason === "string" && reason.trim() ? reason : "(no reason given)";
  await db.insert(revisions).values({
    workspaceId, targetType, targetId, op, reason: safeReason, actor, actorKind: "agent",
    before: jsonb(before), after: jsonb(after), ingestionId: ingestionId ?? null,
  });
}

// ── Verbs ─────────────────────────────────────────────────────────────────────
type BlockInput = { type: string; content: string };

export async function addDocument(
  args: { sectionId: string; title: string; summary?: string; kind?: string; blocks?: string | BlockInput[]; clientKey?: string; reason?: string },
  actor: string,
  ctx?: WriteCtx,
) {
  const wsId = await sectionWorkspace(args.sectionId);

  // Idempotency (#44): same clientKey under the same section → no-op, returns the existing one.
  if (args.clientKey) {
    const [dup] = await db.select().from(documents)
      .where(and(eq(documents.sectionId, args.sectionId), eq(documents.clientKey, args.clientKey))).limit(1);
    if (dup) {
      const dupBlocks = await db.select().from(blocks).where(eq(blocks.documentId, dup.id)).orderBy(blocks.position);
      return { document: dup, blocks: dupBlocks, deduplicated: true };
    }
  }

  // unique slug under the section
  let slug = slugify(args.title);
  const existing = await db.select({ slug: documents.slug }).from(documents).where(eq(documents.sectionId, args.sectionId));
  const taken = new Set(existing.map((d) => d.slug));
  if (taken.has(slug)) { let n = 2; while (taken.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }

  const [doc] = await db.insert(documents).values({
    sectionId: args.sectionId, title: args.title, slug,
    summary: args.summary ?? "", kind: args.kind ?? null, status: "ACTIVE",
    clientKey: args.clientKey ?? null,
    position: await nextPosition("documents", "section_id", args.sectionId),
  }).onConflictDoNothing({ target: [documents.sectionId, documents.clientKey] }).returning();
  // Race lost between the check and the insert: the other request won, return its result.
  if (!doc) return addDocument(args, actor, ctx);

  const toInsert: { documentId: string; type: any; content: string; position: number }[] = [];
  if (typeof args.blocks === "string") {
    splitMarkdown(args.blocks).forEach((content, i) => toInsert.push({ documentId: doc.id, type: "PROSE", content, position: i }));
  } else if (Array.isArray(args.blocks)) {
    args.blocks.forEach((b, i) => toInsert.push({ documentId: doc.id, type: b.type as any, content: b.content, position: i }));
  }
  const blockRows = toInsert.length ? await db.insert(blocks).values(toInsert).returning() : [];
  await embedBlocks(blockRows.map((b) => ({ id: b.id, content: b.content }))); // best-effort (NULL if API down)

  await revise(wsId, "document", doc.id, "create", args.reason ?? `add document "${args.title}"`, actor, null, { title: args.title, slug, blocks: blockRows.length }, ctx?.ingestionId);
  return { document: doc, blocks: blockRows };
}

export async function addBlock(
  args: { documentId: string; type: string; content: string; position?: number; clientKey?: string; reason?: string },
  actor: string,
  ctx?: WriteCtx,
) {
  const wsId = await workspaceIdForTarget("document", args.documentId);
  if (!wsId) throw new Error(`Document not found: ${args.documentId}`);

  // Idempotency (#44): same clientKey in the same document → no-op, returns the existing one.
  if (args.clientKey) {
    const [dup] = await db.select().from(blocks)
      .where(and(eq(blocks.documentId, args.documentId), eq(blocks.clientKey, args.clientKey))).limit(1);
    if (dup) return { ...dup, deduplicated: true };
  }

  const [b] = await db.insert(blocks).values({
    documentId: args.documentId, type: args.type as any, content: args.content,
    clientKey: args.clientKey ?? null,
    position: args.position ?? await nextPosition("blocks", "document_id", args.documentId),
  }).onConflictDoNothing({ target: [blocks.documentId, blocks.clientKey] }).returning();
  if (!b) return addBlock(args, actor, ctx); // race lost check/insert → re-reads the existing one
  await embedBlocks([{ id: b.id, content: b.content }]); // best-effort
  await revise(wsId, "block", b.id, "create", args.reason ?? "add block", actor, null, { type: b.type, content: b.content }, ctx?.ingestionId);
  // Anti-duplicate signal (#44): near-identical blocks already in the database — the agent judges.
  const similar = await nearDuplicates(wsId, { blockId: b.id });
  return similar.length ? { ...b, similarExisting: similar } : b;
}

export async function updateBlock(
  args: { id: string; content?: string; type?: string; reason: string },
  actor: string,
  ctx?: WriteCtx,
) {
  const wsId = await workspaceIdForTarget("block", args.id);
  if (!wsId) throw new Error(`Block not found: ${args.id}`);
  const [before] = await db.select().from(blocks).where(eq(blocks.id, args.id)).limit(1);
  const patch: Record<string, unknown> = {};
  if (args.content !== undefined) patch.content = args.content;
  if (args.type !== undefined) patch.type = args.type as any;
  if (Object.keys(patch).length === 0) {
    throw new Error("update_block: nothing to update — pass `content` and/or `type` (the text field is `content`, not `text`).");
  }
  const [after] = await db.update(blocks).set(patch).where(eq(blocks.id, args.id)).returning();
  if (args.content !== undefined) await embedBlocks([{ id: after.id, content: after.content }]); // best-effort
  await revise(wsId, "block", args.id, "update", args.reason, actor, before, after, ctx?.ingestionId);
  return after;
}

export async function setBlockType(args: { id: string; type: string; reason: string }, actor: string, ctx?: WriteCtx) {
  const wsId = await workspaceIdForTarget("block", args.id);
  if (!wsId) throw new Error(`Block not found: ${args.id}`);
  const [before] = await db.select().from(blocks).where(eq(blocks.id, args.id)).limit(1);
  const [after] = await db.update(blocks).set({ type: args.type as any }).where(eq(blocks.id, args.id)).returning();
  await revise(wsId, "block", args.id, "set_type", args.reason, actor, before, after, ctx?.ingestionId);
  return after;
}

export async function deleteBlock(args: { id: string; reason: string }, actor: string, ctx?: WriteCtx) {
  const wsId = await workspaceIdForTarget("block", args.id);
  if (!wsId) throw new Error(`Block not found: ${args.id}`);
  const [before] = await db.select().from(blocks).where(eq(blocks.id, args.id)).limit(1);
  await db.delete(blocks).where(eq(blocks.id, args.id));
  await revise(wsId, "block", args.id, "delete", args.reason, actor, before, null, ctx?.ingestionId);
  return { deleted: args.id };
}

// ── Sources ───────────────────────────────────────────────────────────────────
/**
 * Attaches a source to a block. Either reuse an existing source (`sourceId`), or
 * create one on the fly (`kind` + `title` required). A source is standalone and
 * reusable: no workspace scope (the block↔source link is).
 */
export async function attachSource(
  args: {
    blockId: string; sourceId?: string;
    kind?: string; title?: string; ref?: string; citation?: string;
    locator?: string; reason?: string;
  },
  actor: string,
  ctx?: WriteCtx,
) {
  const wsId = await workspaceIdForTarget("block", args.blockId);
  if (!wsId) throw new Error(`Block not found: ${args.blockId}`);
  let sourceId = args.sourceId;
  let created: typeof sources.$inferSelect | null = null;
  if (!sourceId) {
    if (!args.kind || !args.title) throw new Error("`sourceId`, or (`kind` + `title`) required");
    [created] = await db.insert(sources).values({
      kind: args.kind as any, title: args.title,
      ref: args.ref ?? null, citation: args.citation ?? null,
    }).returning();
    sourceId = created.id;
  }
  await db.insert(blockSources)
    .values({ blockId: args.blockId, sourceId, locator: args.locator ?? null })
    .onConflictDoNothing();
  await revise(wsId, "block", args.blockId, "attach_source", args.reason ?? "add source", actor, null, { sourceId, locator: args.locator ?? null }, ctx?.ingestionId);
  return { blockId: args.blockId, sourceId, source: created };
}

export async function detachSource(args: { blockId: string; sourceId: string; reason?: string }, actor: string, ctx?: WriteCtx) {
  const wsId = await workspaceIdForTarget("block", args.blockId);
  if (!wsId) throw new Error(`Block not found: ${args.blockId}`);
  await db.delete(blockSources)
    .where(and(eq(blockSources.blockId, args.blockId), eq(blockSources.sourceId, args.sourceId)));
  await revise(wsId, "block", args.blockId, "detach_source", args.reason ?? "remove source", actor, { sourceId: args.sourceId }, null, ctx?.ingestionId);
  return { blockId: args.blockId, sourceId: args.sourceId, detached: true };
}

// ── Verification ───────────────────────────────────────────────────────────────
/** Marks a block as verified (timestamp + actor), or removes the verification (`verified:false`). */
export async function verifyBlock(args: { id: string; verified?: boolean; reason?: string }, actor: string, ctx?: WriteCtx) {
  const wsId = await workspaceIdForTarget("block", args.id);
  if (!wsId) throw new Error(`Block not found: ${args.id}`);
  const [before] = await db.select().from(blocks).where(eq(blocks.id, args.id)).limit(1);
  const verified = args.verified !== false;
  const [after] = await db.update(blocks)
    .set(verified ? { verifiedAt: new Date(), verifiedBy: actor } : { verifiedAt: null, verifiedBy: null })
    .where(eq(blocks.id, args.id)).returning();
  await revise(
    wsId, "block", args.id, verified ? "verify" : "unverify",
    args.reason ?? (verified ? "verified" : "verification removed"),
    actor, { verifiedAt: before.verifiedAt }, { verifiedAt: after.verifiedAt }, ctx?.ingestionId,
  );
  return { id: args.id, verifiedAt: after.verifiedAt, verifiedBy: after.verifiedBy };
}

// ── Move ───────────────────────────────────────────────────────────────────────
/**
 * Moves a block: reorders it within its document, or reattaches it to another document
 * in the same workspace (`toDocumentId`). Renumbers positions flat (0..n-1) in the
 * affected document(s) — dumb server, always dense positions.
 */
export async function moveBlock(
  args: { id: string; toDocumentId?: string; position?: number; reason: string },
  actor: string,
  ctx?: WriteCtx,
) {
  const wsId = await workspaceIdForTarget("block", args.id);
  if (!wsId) throw new Error(`Block not found: ${args.id}`);
  const [block] = await db.select().from(blocks).where(eq(blocks.id, args.id)).limit(1);
  const before = { documentId: block.documentId, position: block.position };

  const targetDoc = args.toDocumentId ?? block.documentId;
  if (targetDoc !== block.documentId) {
    const destWs = await workspaceIdForTarget("document", targetDoc);
    if (!destWs) throw new Error(`Target document not found: ${targetDoc}`);
    if (destWs !== wsId) throw new Error("cross-workspace move forbidden");
  }

  // Destination document: ordered siblings, excluding the moved block, then insertion.
  const dest = (await db.select({ id: blocks.id }).from(blocks)
    .where(eq(blocks.documentId, targetDoc)).orderBy(blocks.position))
    .filter((b) => b.id !== args.id)
    .map((b) => b.id);
  const idx = args.position === undefined ? dest.length : Math.max(0, Math.min(args.position, dest.length));
  dest.splice(idx, 0, args.id);
  for (let i = 0; i < dest.length; i++) {
    await db.update(blocks)
      .set(dest[i] === args.id ? { position: i, documentId: targetDoc } : { position: i })
      .where(eq(blocks.id, dest[i]));
  }
  // Source document (if different): repack the remaining positions.
  if (targetDoc !== block.documentId) {
    const src = (await db.select({ id: blocks.id }).from(blocks)
      .where(eq(blocks.documentId, block.documentId)).orderBy(blocks.position)).map((b) => b.id);
    for (let i = 0; i < src.length; i++) {
      await db.update(blocks).set({ position: i }).where(eq(blocks.id, src[i]));
    }
  }

  const after = { documentId: targetDoc, position: idx };
  await revise(wsId, "block", args.id, "move", args.reason, actor, before, after, ctx?.ingestionId);
  return { id: args.id, ...after };
}

// ── Links & obsolescence (building blocks of the ingestion loop — CONTRADICT/OBSOLETE classes) ──
/** Creates a typed link between two blocks of the same workspace. */
export async function linkBlocks(
  args: { fromId: string; toId: string; relation: string; note?: string; reason?: string },
  actor: string,
  ctx?: WriteCtx,
) {
  const wsId = await workspaceIdForTarget("block", args.fromId);
  if (!wsId) throw new Error(`Block not found: ${args.fromId}`);
  const toWs = await workspaceIdForTarget("block", args.toId);
  if (!toWs) throw new Error(`Block not found: ${args.toId}`);
  if (toWs !== wsId) throw new Error("cross-workspace link forbidden");
  const [l] = await db.insert(links).values({
    fromBlockId: args.fromId, toBlockId: args.toId, relation: args.relation as any,
    note: args.note ?? null, createdBy: actor,
  }).onConflictDoNothing().returning();
  await revise(wsId, "link", l?.id ?? null, "link", args.reason ?? `link ${args.relation}`, actor, null, { fromId: args.fromId, toId: args.toId, relation: args.relation }, ctx?.ingestionId);
  return l ?? { fromBlockId: args.fromId, toBlockId: args.toId, relation: args.relation, note: "already exists" };
}

/** Moves a document to DEPRECATED (obsolescence). `supersededBy` is traced in the revision. */
export async function deprecateDocument(
  args: { id: string; supersededBy?: string; reason: string },
  actor: string,
  ctx?: WriteCtx,
) {
  const wsId = await workspaceIdForTarget("document", args.id);
  if (!wsId) throw new Error(`Document not found: ${args.id}`);
  const [before] = await db.select().from(documents).where(eq(documents.id, args.id)).limit(1);
  const [after] = await db.update(documents).set({ status: "DEPRECATED" }).where(eq(documents.id, args.id)).returning();
  await revise(wsId, "document", args.id, "deprecate", args.reason, actor, { status: before.status }, { status: "DEPRECATED", supersededBy: args.supersededBy ?? null }, ctx?.ingestionId);
  return { id: args.id, status: after.status, supersededBy: args.supersededBy ?? null };
}

/** Restores a DEPRECATED document back to ACTIVE (the inverse of deprecateDocument). */
export async function restoreDocument(args: { id: string; reason?: string }, actor: string, ctx?: WriteCtx) {
  const wsId = await workspaceIdForTarget("document", args.id);
  if (!wsId) throw new Error(`Document not found: ${args.id}`);
  const [before] = await db.select().from(documents).where(eq(documents.id, args.id)).limit(1);
  const [after] = await db.update(documents).set({ status: "ACTIVE" }).where(eq(documents.id, args.id)).returning();
  await revise(wsId, "document", args.id, "restore", args.reason ?? "restore document", actor, { status: before.status }, { status: "ACTIVE" }, ctx?.ingestionId);
  return { id: args.id, status: after.status };
}

/**
 * HARD-deletes a document. Its blocks cascade via FK (`blocks.document_id`
 * onDelete cascade → block_sources, links). Comments are polymorphic (no FK) so we
 * purge them explicitly — on the document itself AND on each of its blocks (whose ids
 * must be read BEFORE the cascade removes them). Irreversible; the revision is the
 * only trace left. Distinct from deprecateDocument (soft, reversible).
 */
export async function deleteDocument(args: { id: string; reason?: string }, actor: string, ctx?: WriteCtx) {
  const wsId = await workspaceIdForTarget("document", args.id);
  if (!wsId) throw new Error(`Document not found: ${args.id}`);
  const [before] = await db.select().from(documents).where(eq(documents.id, args.id)).limit(1);
  const blockIds = (await db.select({ id: blocks.id }).from(blocks).where(eq(blocks.documentId, args.id))).map((b) => b.id);
  // Polymorphic comments (no FK): remove the document's, and each block's, before the cascade.
  await db.delete(comments).where(and(eq(comments.targetType, "DOCUMENT"), eq(comments.targetId, args.id)));
  if (blockIds.length) {
    await db.delete(comments).where(and(eq(comments.targetType, "BLOCK"), inArray(comments.targetId, blockIds)));
  }
  await db.delete(documents).where(eq(documents.id, args.id)); // cascade: blocks → block_sources, links
  await revise(wsId, "document", args.id, "delete", args.reason ?? `delete document "${before.title}"`, actor,
    { title: before.title, slug: before.slug, blocks: blockIds.length }, null, ctx?.ingestionId);
  return { deleted: args.id, blocks: blockIds.length };
}

/** Deletes a typed link between two blocks. */
export async function unlinkBlocks(args: { linkId: string; reason?: string }, actor: string, ctx?: WriteCtx) {
  const [link] = await db.select().from(links).where(eq(links.id, args.linkId)).limit(1);
  if (!link) throw new Error(`Link not found: ${args.linkId}`);
  const wsId = await workspaceIdForTarget("block", link.fromBlockId);
  if (!wsId) throw new Error(`Source block not found: ${link.fromBlockId}`);
  await db.delete(links).where(eq(links.id, args.linkId));
  await revise(wsId, "link", args.linkId, "unlink", args.reason ?? "remove link", actor,
    { fromId: link.fromBlockId, toId: link.toBlockId, relation: link.relation }, null, ctx?.ingestionId);
  return { deleted: args.linkId };
}

// ── Comments (annotations, polymorphic target) ─────────────────────────────────
/** Annotates a block/document/section. Comments are their own trace (author + date). */
export async function addComment(
  args: { targetType: string; targetId: string; body: string; authorKind?: string },
  actor: string,
) {
  const [c] = await db.insert(comments).values({
    targetType: args.targetType as any, targetId: args.targetId, body: args.body,
    author: actor, authorKind: args.authorKind ?? "human",
  }).returning();
  return c;
}

/** Marks a comment as resolved (timestamp). */
export async function resolveComment(args: { id: string }) {
  const [c] = await db.update(comments).set({ resolvedAt: new Date() }).where(eq(comments.id, args.id)).returning();
  if (!c) throw new Error(`Comment not found: ${args.id}`);
  return { id: c.id, resolvedAt: c.resolvedAt };
}
