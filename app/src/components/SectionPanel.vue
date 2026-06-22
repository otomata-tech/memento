<script setup lang="ts">
// Section page — the "map" of a zone: summary, sub-sections, documents (deprecated
// included), plus structural actions (rename · + sub-section · + document ·
// deprecate/restore a document). Live writes; the backend gates (curator/admin).
import { reactive, ref } from "vue";
import { api, type SectionView, type DocMeta } from "../api";
import { toast } from "../lib/toast";
import ConfirmModal from "./ConfirmModal.vue";
import MovePicker from "./MovePicker.vue";

const props = defineProps<{ section: SectionView; ws: string }>();
const emit = defineEmits<{
  (e: "openDoc", id: string): void; (e: "selectSection", id: string): void;
  (e: "changed"): void; (e: "deletedSection"): void;
}>();

const busy = ref(false);
const mode = ref<"" | "rename" | "subsection" | "document">("");
const form = reactive({ title: "", summary: "", slug: "" });
// Pending destructive action (rendered as a ConfirmModal — never a native dialog).
const confirm = ref<{ kind: "doc" | "section"; id: string; title: string; message: string } | null>(null);
// Pending cross-KB move (rendered as a MovePicker modal).
const mover = ref<{ mode: "doc" | "section"; id: string; title: string } | null>(null);

function onMoved() {
  const wasSection = mover.value?.mode === "section";
  mover.value = null;
  // A moved section left this KB → navigate away; a moved doc → just refresh.
  if (wasSection) emit("deletedSection");
  else emit("changed");
}

function friendly(e: unknown): string {
  const s = String(e instanceof Error ? e.message : e);
  return /403|interdit|forbidden|curator|admin/i.test(s) ? "curators/admins only" : s;
}

function openForm(m: "rename" | "subsection" | "document") {
  mode.value = m;
  form.title = m === "rename" ? props.section.section.title : "";
  form.summary = m === "rename" ? props.section.section.summary : "";
  form.slug = m === "rename" ? props.section.section.slug : "";
}

async function submit() {
  if (mode.value !== "rename" && !form.title.trim()) { toast("title required", "err"); return; }
  busy.value = true;
  try {
    const title = form.title.trim();
    const summary = form.summary.trim();
    if (mode.value === "rename") {
      // Pass slug only when it actually changed (default = keep the path stable).
      const slug = form.slug.trim() && form.slug.trim() !== props.section.section.slug ? form.slug.trim() : undefined;
      await api.renameSection({ id: props.section.section.id, title, summary, slug });
      toast(slug ? "Section renamed (slug changed)" : "Section renamed", "ok");
    } else if (mode.value === "subsection") {
      await api.createSection({ workspace: props.ws, parentId: props.section.section.id, title, summary: summary || undefined });
      toast("Sub-section created", "ok");
    } else if (mode.value === "document") {
      await api.createDocument({ sectionId: props.section.section.id, title, summary: summary || undefined });
      toast("Document created", "ok");
    }
    mode.value = "";
    emit("changed");
  } catch (e) { toast(friendly(e), "err"); }
  finally { busy.value = false; }
}

async function toggleStatus(d: DocMeta & { blockCount: number }) {
  busy.value = true;
  try {
    if (d.status === "DEPRECATED") {
      await api.restoreDocument({ id: d.id });
      toast("Document restored", "ok");
    } else {
      await api.deprecateDocument({ id: d.id, reason: "deprecated from the viewer" });
      toast("Document deprecated", "ok");
    }
    emit("changed");
  } catch (e) { toast(friendly(e), "err"); }
  finally { busy.value = false; }
}

function askDeleteDoc(d: DocMeta & { blockCount: number }) {
  confirm.value = { kind: "doc", id: d.id, title: d.title,
    message: `Permanently delete the document "${d.title}" and its ${d.blockCount} block(s)? This cannot be undone.` };
}
function askDeleteSection() {
  const s = props.section;
  const subs = s.subsections.length, docs = s.documents.length;
  confirm.value = { kind: "section", id: s.section.id, title: s.section.title,
    message: `Permanently delete the section "${s.section.title}"` +
      (subs || docs ? ` and everything under it (${subs} sub-section(s), ${docs} document(s))` : "") +
      `? This cannot be undone.` };
}
async function doDelete() {
  const target = confirm.value;
  if (!target) return;
  busy.value = true;
  try {
    if (target.kind === "doc") {
      await api.deleteDocument({ id: target.id });
      toast("Document deleted", "ok");
      confirm.value = null;
      emit("changed");
    } else {
      await api.deleteSection({ id: target.id });
      toast("Section deleted", "ok");
      confirm.value = null;
      emit("deletedSection");
    }
  } catch (e) { toast(friendly(e), "err"); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="doc">
    <div class="eb">Section · <span class="sec-slug">{{ section.section.slug }}</span></div>
    <h1 class="title">{{ section.section.title }}</h1>
    <div v-if="section.section.summary" class="summary">{{ section.section.summary }}</div>

    <!-- Structural action bar -->
    <div class="act sect-act">
      <button class="btn" :disabled="busy" @click="openForm('rename')">✎ rename</button>
      <button class="btn" :disabled="busy" @click="openForm('subsection')">＋ sub-section</button>
      <button class="btn go" :disabled="busy" @click="openForm('document')">＋ document</button>
      <button class="btn" :disabled="busy" @click="mover = { mode: 'section', id: section.section.id, title: section.section.title }">⇄ move</button>
      <button class="btn del" :disabled="busy" @click="askDeleteSection">🗑 delete section</button>
    </div>
    <div v-if="mode" class="srcform sect-form">
      <input v-model="form.title" :placeholder="mode === 'rename' ? 'section title' : (mode === 'subsection' ? 'sub-section title' : 'document title')" />
      <textarea v-model="form.summary" rows="2" placeholder="summary (optional)"></textarea>
      <input v-if="mode === 'rename'" v-model="form.slug" placeholder="slug — URL identifier (e.g. mariage)" />
      <div class="act">
        <button class="btn go" :disabled="busy" @click="submit">save</button>
        <button class="btn" :disabled="busy" @click="mode = ''">cancel</button>
      </div>
    </div>

    <template v-if="section.subsections.length">
      <div class="eb" style="margin-top:22px">Sub-sections</div>
      <div v-for="s in section.subsections" :key="s.id" class="sub-card" @click="emit('selectSection', s.id)">
        <div class="card-title">▸ {{ s.title }}</div>
        <div v-if="s.summary" class="card-summary">{{ s.summary }}</div>
      </div>
    </template>

    <div class="eb" style="margin-top:22px">Documents</div>
    <div v-for="d in section.documents" :key="d.id" class="doc-card" :class="{ dep: d.status === 'DEPRECATED' }">
      <div class="doc-open" @click="emit('openDoc', d.id)">
        <div class="card-title">
          {{ d.title }}
          <span v-if="d.status === 'DEPRECATED'" class="badge depbadge">deprecated</span>
        </div>
        <div v-if="d.summary" class="card-summary">{{ d.summary }}</div>
        <div class="card-count">{{ d.blockCount }} block(s)</div>
      </div>
      <div class="doc-actions">
        <button class="btn mini" :disabled="busy" @click.stop="toggleStatus(d)">
          {{ d.status === 'DEPRECATED' ? '↺ restore' : '⊘ deprecate' }}
        </button>
        <button class="btn mini" :disabled="busy" @click.stop="mover = { mode: 'doc', id: d.id, title: d.title }">⇄ move</button>
        <button class="btn mini del" :disabled="busy" @click.stop="askDeleteDoc(d)">🗑 delete</button>
      </div>
    </div>
    <p v-if="!section.documents.length && !section.subsections.length" class="muted">Empty section — no documents yet.</p>

    <ConfirmModal v-if="confirm"
      :title="confirm.kind === 'section' ? 'Delete section' : 'Delete document'"
      :message="confirm.message" :busy="busy" @confirm="doDelete" @cancel="confirm = null" />
    <MovePicker v-if="mover" :mode="mover.mode" :item-id="mover.id" :item-title="mover.title" :current-ws="ws"
      @moved="onMoved" @cancel="mover = null" />
  </div>
</template>

<style scoped>
.sect-act { margin-top: 14px; flex-wrap: wrap; }
.sect-form { margin-top: 10px; }
.sec-slug { font-family: var(--font-mono); text-transform: none; letter-spacing: 0; opacity: .65; }

/* Section-page cards — own layout (clickable body + actions row), generous spacing */
.sub-card, .doc-card { border: 1px solid var(--color-hair); background: var(--color-surface); padding: 13px 15px; margin-top: 10px; }
.sub-card { cursor: pointer; }
.sub-card:hover, .doc-open:hover { background: var(--color-paper-2, var(--color-bg)); }
.doc-card.dep { opacity: .6; }
.doc-open { cursor: pointer; }
.card-title { font-weight: 600; font-size: 14px; line-height: 1.4; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; overflow-wrap: anywhere; }
.card-summary { font-size: 12.5px; color: var(--color-mute, var(--color-weak-ink)); margin-top: 6px; line-height: 1.5; overflow-wrap: anywhere; }
.card-count { font-family: var(--font-mono); font-size: 11px; opacity: .6; margin-top: 7px; }
.doc-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--color-hair); }
.badge.depbadge { background: var(--color-weak-ink, #b04); color: var(--color-surface, #fff); text-transform: none; }
.btn.mini { font-size: 11.5px; padding: 4px 10px; }
.btn.del { color: var(--color-weak-ink, #b04); border-color: var(--color-weak-ink, #b04); }
</style>
