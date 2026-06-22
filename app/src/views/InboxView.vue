<script setup lang="ts">
// Global inbox — every still-actionable ingestion across ALL the user's orgs/KBs.
// Acts in place: expand to preview the changes, then "Apply all" / "Reject" without
// navigating. Contradictions are never applied by "Apply all" → "Review in detail"
// (the per-KB loop) handles fine-grained selection, edits and contradictions.
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, type InboxItem, type IngestionDetail, type IngestionChange } from "../api";
import AppShell from "../components/AppShell.vue";
import { toast } from "../lib/toast";
import { refreshLoop, shell } from "../stores/shell";

const router = useRouter();
const items = ref<InboxItem[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const open = reactive<Record<string, boolean>>({});
const details = reactive<Record<string, IngestionDetail | null>>({});
const busy = ref<string | null>(null);

const STATUS_LABEL: Record<string, string> = { PROPOSED: "proposed", PARTIAL: "partial", CHANGES_REQUESTED: "sent back" };
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.toLowerCase();
const contradictions = (it: InboxItem) => it.counts.byClass?.CONTRADICT ?? 0;

const groups = computed(() => {
  const m = new Map<string, { org: string; items: InboxItem[] }>();
  for (const it of items.value) {
    const key = it.org ?? "—";
    if (!m.has(key)) m.set(key, { org: it.orgName ?? it.org ?? "—", items: [] });
    m.get(key)!.items.push(it);
  }
  return [...m.values()];
});

async function load() {
  loading.value = true; error.value = null;
  try { items.value = (await api.inbox()).ingestions; }
  catch (e) { error.value = String(e instanceof Error ? e.message : e); }
  finally { loading.value = false; }
}
async function toggle(it: InboxItem) {
  open[it.id] = !open[it.id];
  if (open[it.id] && !details[it.id]) {
    try { details[it.id] = await api.ingestion(it.id); }
    catch (e) { toast(String(e instanceof Error ? e.message : e), "err"); }
  }
}
function snippet(c: IngestionChange): string {
  const p = c.payload as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const txt = s(p.content) || s(p.title)
    || (Array.isArray(p.blocks) ? (p.blocks as any[]).map((b) => s(b?.content)).filter(Boolean).join(" / ") : "")
    || c.rationale || "";
  return txt.length > 220 ? txt.slice(0, 220) + "…" : txt;
}
async function applyAll(it: InboxItem) {
  busy.value = it.id;
  try {
    const res = await api.applyIngestion(it.id);
    const applied = res.results.filter((r) => r.status === "applied").length;
    const failed = res.results.filter((r) => r.status === "error").length;
    const held = res.results.filter((r) => r.status === "held").length;
    toast(failed ? `${applied} applied · ${failed} failed` : `${applied} change(s) applied${held ? ` · ${held} contradiction(s) held` : ""}`, failed ? "err" : "ok");
    open[it.id] = false; delete details[it.id];
    await load();
    await refreshLoop(it.workspace); // sync the global 📥 badge + that KB's pending
  } catch (e) { toast(String(e instanceof Error ? e.message : e), "err"); }
  finally { busy.value = null; }
}
async function reject(it: InboxItem) {
  busy.value = it.id;
  try { await api.rejectIngestion(it.id); toast("Rejected", "ok"); open[it.id] = false; delete details[it.id]; await load(); await refreshLoop(it.workspace); }
  catch (e) { toast(String(e instanceof Error ? e.message : e), "err"); }
  finally { busy.value = null; }
}
function review(it: InboxItem) { router.push({ path: `/w/${it.workspace}/loop`, query: { ing: it.id } }); }
// Live: a realtime "inbox changed" ping refetches the list.
watch(() => shell.realtimeTick, load);
load();
</script>

<template>
  <AppShell page="inbox" ws="">
    <template #crumbs><span>inbox<template v-if="items.length"> · <b>{{ items.length }} pending</b></template></span></template>

    <div class="inbox-page">
      <div class="eb">Pending across all your knowledge bases</div>
      <p class="ipmeta">Everything an agent proposed and that still awaits your decision — every org, every KB. Expand to preview, then apply right here.</p>

      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="error" class="warn-card">{{ error }}</p>
      <p v-else-if="!items.length" class="muted caught">✓ Nothing pending — you're all caught up.</p>

      <div v-for="g in groups" :key="g.org" class="grp">
        <div class="grp-h">{{ g.org }}</div>
        <div v-for="it in g.items" :key="it.id" class="irow" :class="{ open: open[it.id] }">
          <div class="ihead" @click="toggle(it)">
            <span class="stat" :class="it.status === 'PROPOSED' ? 'prop' : it.status === 'CHANGES_REQUESTED' ? 'req' : 'appl'">{{ statusLabel(it.status) }}</span>
            <div class="imain">
              <div class="ititle">{{ it.title }}</div>
              <div class="imeta">
                {{ it.workspaceName }} · {{ it.counts.pending }} pending<span v-if="contradictions(it)" class="cwarn-inline"> · ⚠ {{ contradictions(it) }} contradiction(s)</span><span v-if="it.createdBy"> · {{ it.createdBy }}</span>
              </div>
            </div>
            <span class="exp">{{ open[it.id] ? "▾" : "▸" }}</span>
          </div>

          <div v-if="open[it.id]" class="ibody" @click.stop>
            <p v-if="!details[it.id]" class="muted" style="font-size:12px">Loading changes…</p>
            <template v-else>
              <div v-for="c in details[it.id]!.changes" :key="c.id" class="chgline"
                :class="{ flagged: c.class === 'CONTRADICT', done: c.applied }">
                <div class="chgtop">
                  <span class="cls" :class="'cls-' + c.class">{{ c.class }}</span>
                  <span class="op">{{ c.op }}</span>
                  <span class="tgt">{{ c.target }}</span>
                  <span v-if="c.applied" class="ok">✓ applied</span>
                </div>
                <div v-if="snippet(c)" class="snip">{{ snippet(c) }}</div>
              </div>

              <div class="iactions">
                <button class="btn primary" :disabled="busy === it.id" @click="applyAll(it)">✓ Apply all{{ contradictions(it) ? ' (except contradictions)' : '' }}</button>
                <button class="btn" :disabled="busy === it.id" @click="review(it)">⌅ Review in detail</button>
                <button class="btn no" :disabled="busy === it.id" @click="reject(it)">Reject</button>
              </div>
              <p v-if="contradictions(it)" class="cwarn">⚠ “Apply all” skips contradictions — open “Review in detail” to decide on them.</p>
            </template>
          </div>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.inbox-page { max-width: 820px; margin-inline: auto; padding: 28px 34px; overflow-y: auto; }
.ipmeta { color: var(--color-ink-soft); margin: 4px 0 22px; font-size: 13px; }
.caught { font-size: 15px; color: var(--color-strong-ink); margin-top: 18px; }
.grp { margin-bottom: 22px; }
.grp-h { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--color-faint); margin: 0 0 8px; }
.irow { border: 1px solid var(--color-hair); background: var(--color-surface); margin-bottom: 8px; }
.irow.open { border-color: var(--color-primary); }
.ihead { display: flex; align-items: center; gap: 12px; padding: 12px 14px; cursor: pointer; }
.ihead:hover { background: var(--color-paper-2); }
.stat { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 3px 7px; white-space: nowrap; }
.stat.prop { background: var(--color-primary-soft); color: var(--color-primary-ink); }
.stat.req { background: var(--color-accent-soft); color: #173a5e; }
.stat.appl { background: var(--color-paper-2); color: var(--color-mute); }
.imain { min-width: 0; flex: 1; }
.ititle { font-weight: 600; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
.imeta { font-size: 12px; color: var(--color-mute); margin-top: 3px; }
.cwarn-inline { color: var(--color-weak-ink); }
.exp { font-size: 12px; color: var(--color-faint); }
.ibody { border-top: 1px solid var(--color-hair); padding: 12px 14px; }
.chgline { padding: 8px 0; border-bottom: 1px dashed var(--color-hair-soft, var(--color-hair)); }
.chgline.done { opacity: .55; }
.chgtop { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; }
.cls { font-family: var(--font-mono); font-size: 10px; padding: 2px 6px; border: 1px solid var(--color-hair); white-space: nowrap; }
.cls-CONTRADICT { color: var(--color-weak-ink); border-color: var(--color-weak-ink); }
.op { font-family: var(--font-mono); font-size: 11px; color: var(--color-ink-soft); }
.tgt { color: var(--color-mute); overflow-wrap: anywhere; }
.ok { margin-left: auto; color: var(--color-strong-ink); font-size: 11px; }
.snip { font-size: 12.5px; color: var(--color-ink-soft); line-height: 1.5; margin-top: 5px; overflow-wrap: anywhere; }
.iactions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.cwarn { font-size: 12px; color: var(--color-weak-ink); margin-top: 8px; }
.btn { font: inherit; font-size: 12.5px; padding: 6px 13px; border: 1px solid var(--color-hair); background: var(--color-surface); color: var(--color-ink); cursor: pointer; }
.btn:hover { border-color: var(--color-primary); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.primary { border-color: var(--color-primary-ink); background: var(--color-primary); color: var(--color-primary-ink); font-weight: 700; }
.btn.no { color: var(--color-weak-ink); border-color: var(--color-weak-ink); }
</style>
