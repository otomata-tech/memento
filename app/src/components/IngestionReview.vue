<script setup lang="ts">
// Propose-validate review of ONE ingestion — the rich per-change card (effective body,
// before→after diff, in-place edit, feedback ping-pong) + apply/send-back/reject bar.
// Shared by the per-KB Loop and the global Inbox: same card everywhere. Driven by the
// ingestion id (works cross-workspace); `ws` is only needed for the "view block" graph link.
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, type IngestionDetail, type IngestionChange } from "../api";
import { renderMd } from "../lib/blocks";
import { toast } from "../lib/toast";

const props = defineProps<{ id: string; ws: string }>();
const emit = defineEmits<{ (e: "changed"): void }>();
const router = useRouter();

const detail = ref<IngestionDetail | null>(null);
const selected = reactive<Record<string, boolean>>({});
const befores = reactive<Record<string, string>>({}); // current content of blocks targeted by update_block → diff
const editing = reactive<Record<string, boolean>>({}); // changes opened for in-place editing
const editBuf = reactive<Record<string, any>>({});     // edit buffer per change
const fbOpen = reactive<Record<string, boolean>>({});  // feedback area open per change
const fbBuf = reactive<Record<string, string>>({});    // human feedback per change
const note = ref("");                                  // global review note (→ agent)
const busy = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);

const actionable = computed(() => ["PROPOSED", "PARTIAL", "CHANGES_REQUESTED"].includes(detail.value?.status ?? ""));
const editableOps = new Set(["add_block", "update_block", "add_document"]);

// A change is selectable (pre-checked) if it's neither applied nor a contradiction (never
// auto-applied). A CONTRADICT can still be force-accepted by an explicit human toggle below.
const selectable = (c: IngestionChange) => !c.applied && c.class !== "CONTRADICT";
const acceptIds = computed(() => detail.value?.changes.filter((c) => !c.applied && selected[c.id]).map((c) => c.id) ?? []);
const allSelectable = computed(() => detail.value?.changes.filter(selectable) ?? []);
const contradictions = computed(() => detail.value?.changes.filter((c) => !c.applied && c.class === "CONTRADICT").length ?? 0);
const blockOps = new Set(["attach_source", "detach_source", "link_blocks", "update_block", "set_block_type", "verify_block", "move_block", "delete_block"]);
function targetBlockId(c: IngestionChange): string | null {
  const p = c.payload as Record<string, unknown>;
  const id = (p?.blockId ?? p?.id) as string | undefined;
  return blockOps.has(c.op) && typeof id === "string" ? id : null;
}

// The EFFECTIVE content of a change (what will be written), not just the rationale (the why).
function changeBody(c: IngestionChange): { kind: string; md: string } | null {
  const p = c.payload as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  if (c.op === "add_block") { const md = s(p.content); return md.trim() ? { kind: s(p.type) || "BLOCK", md } : null; }
  if (c.op === "update_block") { const md = s(p.content); return md.trim() ? { kind: "new content", md } : null; }
  if (c.op === "add_document") {
    const parts: string[] = [];
    if (s(p.title)) parts.push(`# ${s(p.title)}`);
    if (s(p.summary)) parts.push(s(p.summary));
    if (typeof p.blocks === "string") parts.push(s(p.blocks));
    else if (Array.isArray(p.blocks)) parts.push(...(p.blocks as unknown[]).map((b) => s((b as Record<string, unknown>)?.content)).filter(Boolean));
    return parts.length ? { kind: "DOCUMENT", md: parts.join("\n\n") } : null;
  }
  return null;
}
function payloadPreview(c: IngestionChange): string {
  const p = c.payload as Record<string, unknown>;
  return Object.entries(p)
    .filter(([k]) => !["content", "reason", "clientKey", "blocks"].includes(k))
    .map(([k, v]) => { const t = typeof v === "string" ? v : JSON.stringify(v); return `${k}: ${t.length > 80 ? t.slice(0, 80) + "…" : t}`; })
    .join("  ·  ");
}
const bodies = computed(() => Object.fromEntries((detail.value?.changes ?? []).map((c) => [c.id, changeBody(c)])));

const esc = (s: string) => s.replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]!));
// Word-by-word diff via LCS (O(n·m), sufficient for a block) — equal / added / removed segments.
function wordDiff(a: string, b: string): { t: "eq" | "add" | "del"; s: string }[] {
  const A = a.split(/(\s+)/), B = b.split(/(\s+)/), n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: "eq" | "add" | "del"; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) out.push({ t: "eq", s: A[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "del", s: A[i++] });
    else out.push({ t: "add", s: B[j++] });
  }
  while (i < n) out.push({ t: "del", s: A[i++] });
  while (j < m) out.push({ t: "add", s: B[j++] });
  return out;
}
function diffHtml(c: IngestionChange): string | null {
  const body = bodies.value[c.id];
  if (c.op !== "update_block" || befores[c.id] == null || !body) return null;
  return wordDiff(befores[c.id], body.md)
    .map((g) => g.t === "eq" ? esc(g.s) : g.t === "add" ? `<ins>${esc(g.s)}</ins>` : `<del>${esc(g.s)}</del>`)
    .join("");
}

// ── Tier 1: in-place editing (the human takes the pen before application) ──
function editableFields(c: IngestionChange) {
  const p = c.payload as Record<string, any>;
  if (c.op === "add_document") return {
    title: typeof p.title === "string" ? p.title : "",
    blocks: Array.isArray(p.blocks) ? p.blocks.map((b: any) => ({ type: b?.type ?? "PROSE", content: b?.content ?? "" })) : [],
  };
  return { content: typeof p.content === "string" ? p.content : "" };
}
function startEdit(c: IngestionChange) { editBuf[c.id] = JSON.parse(JSON.stringify(editableFields(c))); editing[c.id] = true; }
function cancelEdit(id: string) { editing[id] = false; delete editBuf[id]; }
function editPatch(c: IngestionChange): Record<string, unknown> {
  const b = editBuf[c.id];
  return c.op === "add_document" ? { title: b.title, blocks: b.blocks } : { content: b.content };
}
const editsPayload = () => (detail.value?.changes ?? [])
  .filter((c) => editing[c.id] && selectable(c) && selected[c.id])
  .map((c) => ({ id: c.id, payload: editPatch(c) }));

// ── Tier 2: feedback → send back to the agent (ping-pong) ──
function feedbackItems(): { changeId?: string; body: string }[] {
  const items: { changeId?: string; body: string }[] = [];
  for (const c of detail.value?.changes ?? []) { const body = fbBuf[c.id]?.trim(); if (body) items.push({ changeId: c.id, body }); }
  return items;
}
const hasFeedback = computed(() => note.value.trim().length > 0 || feedbackItems().length > 0);

async function loadDetail() {
  loading.value = true; error.value = null;
  try {
    detail.value = await api.ingestion(props.id);
    for (const r of [selected, befores, editing, editBuf, fbOpen, fbBuf]) for (const k of Object.keys(r)) delete (r as any)[k];
    note.value = "";
    for (const c of detail.value.changes) selected[c.id] = selectable(c); // pre-checked by default
    await Promise.all(detail.value.changes
      .filter((c) => c.op === "update_block")
      .map(async (c) => {
        const bid = targetBlockId(c);
        if (!bid) return;
        try { befores[c.id] = (await api.block(bid)).content; } catch { /* block inaccessible → no diff */ }
      }));
  } catch (e) { error.value = msg(e); }
  finally { loading.value = false; }
}

// Tick every selectable change (skips already-applied + contradictions) then apply.
async function applyAll() {
  for (const c of allSelectable.value) selected[c.id] = true;
  await apply();
}
async function apply() {
  if (!detail.value || !acceptIds.value.length) return;
  busy.value = true; error.value = null;
  try {
    const res = await api.applyIngestion(detail.value.id, acceptIds.value, editsPayload());
    const applied = res.results.filter((r) => r.status === "applied").length;
    const failed = res.results.filter((r) => r.status === "error");
    if (failed.length) {
      error.value = failed.map((r) => r.error).filter(Boolean).join(" · ");
      toast(`${applied} applied · ${failed.length} failed`, "err");
    } else toast(`${applied} change(s) applied`, "ok");
    await loadDetail(); emit("changed");
  }
  catch (e) { error.value = msg(e); toast(error.value, "err"); } finally { busy.value = false; }
}
async function rejectAll() {
  if (!detail.value) return;
  busy.value = true; error.value = null;
  try { await api.rejectIngestion(detail.value.id); toast("Ingestion rejected", "ok"); await loadDetail(); emit("changed"); }
  catch (e) { error.value = msg(e); toast(error.value, "err"); } finally { busy.value = false; }
}
async function sendBack() {
  if (!detail.value || !hasFeedback.value) return;
  busy.value = true; error.value = null;
  try {
    await api.requestChanges(detail.value.id, { note: note.value.trim() || undefined, items: feedbackItems() });
    toast("Sent back to the agent for revision", "ok");
    await loadDetail(); emit("changed");
  } catch (e) { error.value = msg(e); toast(error.value, "err"); } finally { busy.value = false; }
}
function openGraph(id: string) { router.push(`/w/${props.ws}/graph/${id}`); }
function msg(e: unknown): string {
  const s = String(e instanceof Error ? e.message : e);
  return /403|interdit|forbidden|curator|admin/i.test(s) ? "curators/admins only" : s;
}

watch(() => props.id, loadDetail, { immediate: true });
</script>

<template>
  <div class="ireview">
    <template v-if="detail">
      <p v-if="actionable" class="rhint">Each change is <b>pre-ticked</b>. Untick the ones to skip, then click <b>“Apply”</b> at the bottom — the tick is a selection, not an action.</p>
      <p v-if="detail.status === 'CHANGES_REQUESTED'" class="reqbanner">
        ↩ Sent back to the agent — awaiting a new proposal (same clientKey).
        <template v-if="detail.reviewNote"><br><b>Review note:</b> {{ detail.reviewNote }}</template>
      </p>

      <div v-for="c in detail.changes" :key="c.id" class="chg"
        :class="{ flagged: c.class === 'CONTRADICT', sel: selected[c.id] && !c.applied, done: c.applied }">
        <div class="chghead">
          <span class="cls" :class="'cls-' + c.class">{{ c.class }}</span>
          <span class="op">{{ c.op }}</span>
          <span class="tgt">{{ c.target }}</span>
          <span v-if="c.edited" class="editmark">✎ edited</span>
          <button v-if="targetBlockId(c)" class="btn vbtn" style="font-size:11.5px;padding:3px 9px" @click="openGraph(targetBlockId(c)!)">⌖ view the block</button>
        </div>

        <!-- In-place editing (Tier 1) -->
        <div v-if="editing[c.id]" class="editor">
          <template v-if="c.op === 'add_document'">
            <input class="ein" v-model="editBuf[c.id].title" placeholder="document title" />
            <div v-for="(b, bi) in editBuf[c.id].blocks" :key="bi" class="eblk">
              <span class="btype">{{ b.type }}</span>
              <textarea class="eta" v-model="b.content" rows="3"></textarea>
            </div>
          </template>
          <textarea v-else class="eta" v-model="editBuf[c.id].content" rows="4"></textarea>
          <div class="erow"><button class="btn ghost" @click="cancelEdit(c.id)">cancel editing</button><span class="ehint mono">your edits will be written on application</span></div>
        </div>
        <!-- Display of the effective content -->
        <template v-else>
          <div v-if="bodies[c.id]" class="cbody">
            <span class="btype">{{ diffHtml(c) ? "modification (before → after)" : bodies[c.id]!.kind }}</span>
            <div v-if="diffHtml(c)" class="btext diff" v-html="diffHtml(c)" />
            <div v-else class="btext" v-html="renderMd(bodies[c.id]!.md)" />
          </div>
          <div v-else-if="payloadPreview(c)" class="cbody mono">{{ payloadPreview(c) }}</div>
        </template>

        <p v-if="c.rationale" class="rat"><span class="ratlbl">why</span> {{ c.rationale }}</p>

        <!-- Existing feedback (ping-pong) -->
        <div v-if="c.feedback?.length" class="fblist">
          <div v-for="(f, fi) in c.feedback" :key="fi" class="fbitem">
            <span class="fbwho">{{ f.authorKind === 'agent' ? '🤖' : '🧑' }}</span>
            <span class="fbbody">{{ f.body }}</span>
          </div>
        </div>
        <!-- New feedback for the agent -->
        <div v-if="fbOpen[c.id] && !c.applied" class="fbbox">
          <textarea class="eta" v-model="fbBuf[c.id]" rows="2" placeholder="feedback for the agent on this change…"></textarea>
        </div>

        <p v-if="c.error" class="warn-card" style="margin-top:8px">⚠ apply failed: {{ c.error }}</p>

        <div v-if="c.applied" class="lock" style="color:var(--color-strong-ink)">✓ applied</div>
        <template v-else-if="c.class === 'CONTRADICT'">
          <div class="lock">🔒 contradiction — never auto-applied <span class="mono" style="color:var(--color-faint)">→ requires your explicit decision</span></div>
          <div class="act">
            <button class="btn" :class="selected[c.id] ? 'go' : 'no'" @click="selected[c.id] = !selected[c.id]">
              {{ selected[c.id] ? "✓ will be force-accepted" : "⚠ force-accept (override)" }}
            </button>
            <button class="btn ghost" :class="{ on: fbOpen[c.id] }" @click="fbOpen[c.id] = !fbOpen[c.id]">💬 comment</button>
          </div>
        </template>
        <div v-else class="act">
          <button class="btn" :class="selected[c.id] ? 'go' : 'no'" @click="selected[c.id] = !selected[c.id]"
            :title="selected[c.id] ? 'Included in Apply — click to exclude' : 'Excluded — click to include'">
            {{ selected[c.id] ? "☑ will apply" : "☐ skipped" }}
          </button>
          <button v-if="editableOps.has(c.op) && !editing[c.id]" class="btn ghost" @click="startEdit(c)">✎ edit</button>
          <button class="btn ghost" :class="{ on: fbOpen[c.id] }" @click="fbOpen[c.id] = !fbOpen[c.id]">💬 comment</button>
        </div>
      </div>

      <div class="applybar" v-if="actionable">
        <button class="btn primary" :disabled="busy || !allSelectable.length" @click="applyAll">✓ Apply all{{ contradictions ? ' (except contradictions)' : '' }}</button>
        <button class="btn" :disabled="busy || !acceptIds.length" @click="apply">Apply {{ acceptIds.length }} selected</button>
        <button class="btn sendback" :disabled="busy || !hasFeedback" @click="sendBack">↩ Send back to agent</button>
        <button class="btn no" :disabled="busy" @click="rejectAll">Reject all</button>
        <span class="hint">one MemRevision per op · reversible</span>
      </div>
      <div class="notebox" v-if="actionable">
        <textarea class="eta" v-model="note" rows="2" placeholder="global review note for the agent (optional) — e.g. “keep the verbatim but split the hero into 2 documents”"></textarea>
      </div>
      <p v-if="error" class="warn-card" style="margin-top:10px">{{ error }}</p>
    </template>
    <p v-else-if="loading" class="muted">Loading…</p>
    <p v-else-if="error" class="warn-card">{{ error }}</p>
  </div>
</template>
