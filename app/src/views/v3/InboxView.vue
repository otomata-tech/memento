<script setup lang="ts">
/**
 * Memento V3 — Boîte de réception (Revue des propositions).
 * Liste les ingestions actionnables (PROPOSED / CHANGES_REQUESTED) de la base
 * active et permet de les trancher : Accepter (apply), Renvoyer (send_back avec
 * note inline), Rejeter (reject). Remplace le /home cassé.
 */
import { ref, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import { apiV3 } from "../../api.v3";
import type { IngestionRow, Digest } from "../../api.v3";
import { currentBase } from "../../v3/base";

const router = useRouter();

const OPEN_STATUSES = new Set(["PROPOSED", "CHANGES_REQUESTED"]);

const items = ref<IngestionRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const flash = ref<string | null>(null);

// Action en cours par ingestion (désactive ses boutons + spinner).
const busy = ref<Record<string, boolean>>({});
// Ligne dont le champ de note « renvoyer » est ouvert.
const sendBackFor = ref<string | null>(null);
const sendBackNote = ref("");

// Encart activité récente (best-effort).
const digest = ref<Digest | null>(null);
const digestOpen = ref(false);

async function loadInbox() {
  if (!currentBase.value) {
    items.value = [];
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const res = await apiV3.list<IngestionRow>("ingestions", {
      base: currentBase.value,
      limit: 100,
    });
    items.value = res.items
      .filter((i) => OPEN_STATUSES.has(i.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function loadDigest() {
  digest.value = null;
  if (!currentBase.value) return;
  try {
    digest.value = await apiV3.digest(currentBase.value, 7);
  } catch {
    // best-effort : ne bloque jamais l'inbox.
  }
}

function notify(msg: string) {
  flash.value = msg;
  window.setTimeout(() => {
    if (flash.value === msg) flash.value = null;
  }, 4000);
}

function dropRow(id: string) {
  items.value = items.value.filter((i) => i.id !== id);
}

async function accept(row: IngestionRow) {
  if (busy.value[row.id]) return;
  busy.value = { ...busy.value, [row.id]: true };
  try {
    await apiV3.apply(row.id);
    dropRow(row.id);
    notify(`« ${row.title} » acceptée (application + indexation lancées).`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    const { [row.id]: _, ...rest } = busy.value;
    busy.value = rest;
  }
}

async function reject(row: IngestionRow) {
  if (busy.value[row.id]) return;
  busy.value = { ...busy.value, [row.id]: true };
  try {
    await apiV3.review(row.id, "reject");
    dropRow(row.id);
    notify(`« ${row.title} » rejetée.`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    const { [row.id]: _, ...rest } = busy.value;
    busy.value = rest;
  }
}

function openSendBack(row: IngestionRow) {
  sendBackFor.value = row.id;
  sendBackNote.value = "";
}

function cancelSendBack() {
  sendBackFor.value = null;
  sendBackNote.value = "";
}

async function confirmSendBack(row: IngestionRow) {
  if (busy.value[row.id]) return;
  busy.value = { ...busy.value, [row.id]: true };
  try {
    await apiV3.review(row.id, "send_back", sendBackNote.value.trim() || undefined);
    dropRow(row.id);
    cancelSendBack();
    notify(`« ${row.title} » renvoyée à l'agent.`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    const { [row.id]: _, ...rest } = busy.value;
    busy.value = rest;
  }
}

function statusLabel(s: string): string {
  if (s === "PROPOSED") return "Proposée";
  if (s === "CHANGES_REQUESTED") return "Renvoyée";
  return s;
}

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "à l'instant";
  const min = Math.round(sec / 60);
  if (min < 60) return `il y a ${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `il y a ${hr} h`;
  const day = Math.round(hr / 24);
  if (day < 31) return `il y a ${day} j`;
  return new Date(iso).toLocaleDateString("fr-FR");
}

function openPage(id: string) {
  router.push(`/v3/page/${id}`);
}

watch(currentBase, () => {
  loadInbox();
  loadDigest();
});

onMounted(() => {
  loadInbox();
  loadDigest();
});
</script>

<template>
  <section class="inbox">
    <header class="head">
      <h1>Boîte de réception</h1>
      <p class="sub">Propositions en attente de revue dans cette base.</p>
    </header>

    <p v-if="flash" class="flash">{{ flash }}</p>
    <p v-if="error" class="err">{{ error }}</p>

    <p v-if="loading" class="muted">Chargement…</p>

    <ul v-else-if="items.length" class="list">
      <li v-for="row in items" :key="row.id" class="row">
        <div class="row-main">
          <div class="row-text">
            <span class="badge" :class="row.status === 'CHANGES_REQUESTED' ? 'b-back' : 'b-prop'">
              {{ statusLabel(row.status) }}
            </span>
            <span class="title">{{ row.title || "(sans titre)" }}</span>
            <span class="date">{{ relativeDate(row.created_at) }}</span>
          </div>
          <div class="actions">
            <button class="btn primary" :disabled="busy[row.id]" @click="accept(row)">Accepter</button>
            <button class="btn ghost" :disabled="busy[row.id]" @click="openSendBack(row)">Renvoyer</button>
            <button class="btn ghost danger" :disabled="busy[row.id]" @click="reject(row)">Rejeter</button>
          </div>
        </div>

        <div v-if="sendBackFor === row.id" class="sendback">
          <textarea
            v-model="sendBackNote"
            class="note"
            rows="2"
            placeholder="Note pour l'agent (optionnel) : ce qu'il faut corriger…"
          ></textarea>
          <div class="sendback-actions">
            <button class="btn primary" :disabled="busy[row.id]" @click="confirmSendBack(row)">
              Renvoyer à l'agent
            </button>
            <button class="btn ghost" :disabled="busy[row.id]" @click="cancelSendBack">Annuler</button>
          </div>
        </div>
      </li>
    </ul>

    <div v-else class="empty">
      <p class="empty-title">Rien à revoir</p>
      <p class="muted">Aucune proposition en attente dans cette base.</p>
    </div>

    <section v-if="digest && digest.recentPages.length" class="digest">
      <button class="digest-toggle" @click="digestOpen = !digestOpen">
        <span>{{ digestOpen ? "▾" : "▸" }}</span> Activité récente (7 j)
      </button>
      <ul v-if="digestOpen" class="digest-list">
        <li v-for="p in digest.recentPages" :key="p.id">
          <a class="digest-link" @click.prevent="openPage(p.id)" :href="`/v3/page/${p.id}`">{{ p.title }}</a>
          <span v-if="p.description" class="digest-desc">— {{ p.description }}</span>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.inbox {
  max-width: 760px;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
  color: var(--color-ink, #1a1a1a);
}
.head { margin-bottom: 1.5rem; }
.head h1 {
  font-family: var(--font-display, serif);
  font-size: 1.7rem;
  margin: 0 0 0.25rem;
}
.sub { color: var(--color-mute, #6b6b6b); margin: 0; }
.muted { color: var(--color-mute, #6b6b6b); }

.flash {
  background: var(--color-bg, #faf9f7);
  border: 1px solid var(--color-hair, #e5e2dc);
  border-left: 3px solid var(--color-primary, #b5532a);
  padding: 0.6rem 0.8rem;
  border-radius: 6px;
  margin: 0 0 1rem;
}
.err {
  background: #fdf2ee;
  border: 1px solid #e8b9a8;
  color: #8a2d10;
  padding: 0.6rem 0.8rem;
  border-radius: 6px;
  margin: 0 0 1rem;
}

.list { list-style: none; margin: 0; padding: 0; }
.row {
  border: 1px solid var(--color-hair, #e5e2dc);
  background: var(--color-surface, #fff);
  border-radius: 8px;
  padding: 0.85rem 1rem;
  margin-bottom: 0.75rem;
}
.row-main {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.row-text { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; min-width: 0; }
.title { font-weight: 600; }
.date { color: var(--color-mute, #6b6b6b); font-size: 0.82rem; }

.badge {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  border: 1px solid var(--color-hair, #e5e2dc);
}
.b-prop { background: var(--color-bg, #faf9f7); color: var(--color-mute, #6b6b6b); }
.b-back { background: #fdf2ee; color: #8a2d10; border-color: #e8b9a8; }

.actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
.btn {
  font: inherit;
  font-size: 0.85rem;
  padding: 0.4rem 0.85rem;
  border-radius: 6px;
  border: 1px solid var(--color-hair, #e5e2dc);
  background: var(--color-surface, #fff);
  color: var(--color-ink, #1a1a1a);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary {
  background: var(--color-primary, #b5532a);
  border-color: var(--color-primary, #b5532a);
  color: #fff;
}
.btn.primary:not(:disabled):hover { filter: brightness(1.05); }
.btn.ghost { background: transparent; }
.btn.ghost:not(:disabled):hover { background: var(--color-bg, #faf9f7); }
.btn.ghost.danger { color: #a23b1c; border-color: #e8b9a8; }
.btn.ghost.danger:not(:disabled):hover { background: #fdf2ee; }

.sendback { margin-top: 0.75rem; }
.note {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-size: 0.88rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 6px;
  background: var(--color-bg, #faf9f7);
  color: var(--color-ink, #1a1a1a);
  resize: vertical;
}
.sendback-actions { display: flex; gap: 0.4rem; margin-top: 0.5rem; }

.empty {
  text-align: center;
  padding: 3rem 1rem;
  border: 1px dashed var(--color-hair, #e5e2dc);
  border-radius: 8px;
  background: var(--color-surface, #fff);
}
.empty-title {
  font-family: var(--font-display, serif);
  font-size: 1.2rem;
  margin: 0 0 0.3rem;
}

.digest { margin-top: 2rem; border-top: 1px solid var(--color-hair, #e5e2dc); padding-top: 1rem; }
.digest-toggle {
  font: inherit;
  font-size: 0.9rem;
  background: none;
  border: none;
  color: var(--color-mute, #6b6b6b);
  cursor: pointer;
  padding: 0;
}
.digest-list { list-style: none; margin: 0.75rem 0 0; padding: 0; }
.digest-list li { padding: 0.25rem 0; font-size: 0.9rem; }
.digest-link { color: var(--color-primary, #b5532a); text-decoration: none; cursor: pointer; }
.digest-link:hover { text-decoration: underline; }
.digest-desc { color: var(--color-mute, #6b6b6b); }
</style>
