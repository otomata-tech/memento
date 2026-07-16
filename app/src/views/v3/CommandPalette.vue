<script setup lang="ts">
/**
 * Memento V3 — palette de commandes (⌘K / Ctrl+K). Navigation rapide au clavier +
 * recherche de pages en direct dans la base courante. Montée globalement dans V3Layout.
 * S'ouvre via le raccourci global ou via `defineExpose({ open })` (bouton du shell).
 * Pattern ARIA combobox + listbox (aria-activedescendant) ; focus piégé tant qu'ouverte.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useRouter } from "vue-router";
import { apiV3, type SearchHit } from "../../api.v3";
import { currentBase } from "../../v3/base";

const router = useRouter();

const open = ref(false);
const query = ref("");
const results = ref<SearchHit[]>([]);
const loading = ref(false);
const activeIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
let restoreFocus: HTMLElement | null = null;
let searchTimer: number | undefined;
let searchSeq = 0;

type Item = { kind: "nav" | "page"; label: string; sublabel?: string; run: () => void };

const NAV: { label: string; to: string }[] = [
  { label: "Pages", to: "/pages" },
  { label: "Recherche", to: "/search" },
  { label: "Boîte de réception", to: "/inbox" },
  { label: "Organisation", to: "/org" },
  { label: "Connecteur", to: "/connector" },
];

function go(to: string) {
  // On navigue : fermer SANS restituer le focus au déclencheur (la vue de
  // destination gère son focus ; le rendre au bouton ⌘K serait désorientant).
  close(false);
  if (router.currentRoute.value.fullPath !== to) router.push(to);
}

const navItems = computed<Item[]>(() => {
  const q = query.value.trim().toLowerCase();
  return NAV.filter((n) => !q || n.label.toLowerCase().includes(q)).map((n) => ({
    kind: "nav",
    label: n.label,
    sublabel: "Aller à",
    run: () => go(n.to),
  }));
});

const pageItems = computed<Item[]>(() =>
  results.value.map((h) => ({
    kind: "page",
    label: h.title || "Sans titre",
    sublabel: h.description || undefined,
    run: () => go(`/page/${h.pageId}`),
  })),
);

const items = computed<Item[]>(() => [...navItems.value, ...pageItems.value]);

watch(items, () => {
  if (activeIndex.value >= items.value.length) activeIndex.value = 0;
});

// Recherche débouncée ; on ignore les réponses obsolètes via une séquence
// (bumpée aussi à open/close pour qu'une réponse en vol d'une session fermée soit jetée).
watch(query, (q) => {
  window.clearTimeout(searchTimer);
  activeIndex.value = 0;
  const term = q.trim();
  if (!term || !currentBase.value) {
    results.value = [];
    loading.value = false;
    return;
  }
  loading.value = true;
  const seq = ++searchSeq;
  searchTimer = window.setTimeout(async () => {
    try {
      const hits = await apiV3.search(term, { base: currentBase.value, scope: "savoir", limit: 8 });
      if (seq === searchSeq) results.value = hits;
    } catch {
      if (seq === searchSeq) results.value = [];
    } finally {
      if (seq === searchSeq) loading.value = false;
    }
  }, 200);
});

async function openPalette() {
  if (open.value) return;
  // Ne pas empiler sur une autre modale (ex. SharePanel) déjà ouverte.
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  restoreFocus = document.activeElement as HTMLElement | null;
  searchSeq++; // invalide toute réponse en vol d'une session précédente
  open.value = true;
  query.value = "";
  results.value = [];
  loading.value = false;
  activeIndex.value = 0;
  await nextTick();
  inputEl.value?.focus();
}

function close(restore = true) {
  if (!open.value) return;
  open.value = false;
  window.clearTimeout(searchTimer);
  searchSeq++; // toute réponse en vol échoue désormais le garde `seq === searchSeq`
  results.value = [];
  loading.value = false;
  if (restore) restoreFocus?.focus();
}

function move(delta: number) {
  const n = items.value.length;
  if (n === 0) return;
  activeIndex.value = (activeIndex.value + delta + n) % n;
}

function runActive() {
  items.value[activeIndex.value]?.run();
}

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    open.value ? close() : openPalette();
    return;
  }
  if (open.value && e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.isComposing) return; // ne pas intercepter Entrée/flèches en cours de saisie IME
  if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (e.key === "Enter") { e.preventDefault(); runActive(); }
  else if (e.key === "Tab") { e.preventDefault(); } // piège de focus : l'input est le seul focusable
}

// Garde l'item actif visible quand on navigue au clavier.
watch(activeIndex, async () => {
  await nextTick();
  listEl.value?.querySelector(".cmdk-item.active")?.scrollIntoView({ block: "nearest" });
});

onMounted(() => document.addEventListener("keydown", onGlobalKeydown));
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  window.clearTimeout(searchTimer);
});

defineExpose({ open: openPalette });
</script>

<template>
  <div v-if="open" class="cmdk-overlay" @click.self="close()">
    <div class="cmdk" role="dialog" aria-modal="true" aria-label="Palette de commandes">
      <input
        ref="inputEl"
        v-model="query"
        class="cmdk-input"
        type="text"
        placeholder="Aller à… ou rechercher une page"
        autocomplete="off"
        role="combobox"
        aria-expanded="true"
        aria-controls="cmdk-listbox"
        :aria-activedescendant="items.length ? 'cmdk-opt-' + activeIndex : undefined"
        aria-label="Commande ou recherche"
        @keydown="onInputKeydown"
      />
      <ul id="cmdk-listbox" ref="listEl" class="cmdk-list" role="listbox" aria-label="Résultats">
        <li
          v-for="(it, i) in items"
          :id="'cmdk-opt-' + i"
          :key="it.kind + ':' + i"
          class="cmdk-item"
          :class="{ active: i === activeIndex }"
          role="option"
          :aria-selected="i === activeIndex"
          @click="it.run()"
          @mousemove="activeIndex = i"
        >
          <span class="cmdk-kind" aria-hidden="true">{{ it.kind === 'nav' ? '↪' : '▤' }}</span>
          <span class="cmdk-text">
            <span class="cmdk-label">{{ it.label }}</span>
            <span v-if="it.sublabel" class="cmdk-sub">{{ it.sublabel }}</span>
          </span>
        </li>
      </ul>
      <p v-if="loading && !pageItems.length" class="cmdk-state" role="status" aria-live="polite">Recherche…</p>
      <p v-else-if="query && !loading && !items.length" class="cmdk-state" role="status" aria-live="polite">
        Aucun résultat.
      </p>
      <div class="cmdk-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> naviguer</span>
        <span><kbd>↵</kbd> ouvrir</span>
        <span><kbd>Échap</kbd> fermer</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cmdk-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  background: rgba(26, 26, 26, 0.32);
}
.cmdk {
  width: 100%;
  max-width: 560px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
.cmdk-input {
  font: inherit;
  font-size: 1rem;
  padding: 0.9rem 1.1rem;
  border: none;
  border-bottom: 1px solid var(--color-hair, #e5e2dc);
  background: var(--color-surface, #fff);
  color: var(--color-ink, #1a1a1a);
  outline: none;
}
.cmdk-list {
  list-style: none;
  margin: 0;
  padding: 0.4rem;
  overflow-y: auto;
}
.cmdk-state {
  margin: 0;
  padding: 0.8rem 1rem;
  color: var(--color-mute, #6b6b6b);
  font-size: 0.9rem;
  border-top: 1px solid var(--color-hair, #e5e2dc);
}
.cmdk-item {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.55rem 0.7rem;
  border-radius: 8px;
  cursor: pointer;
}
.cmdk-item.active {
  background: color-mix(in srgb, var(--color-primary, #b5532a) 10%, transparent);
}
.cmdk-kind {
  flex: 0 0 auto;
  width: 1.3rem;
  text-align: center;
  color: var(--color-mute, #6b6b6b);
  font-size: 0.85rem;
}
.cmdk-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.cmdk-label {
  font-size: 0.92rem;
  color: var(--color-ink, #1a1a1a);
}
.cmdk-sub {
  font-size: 0.78rem;
  color: var(--color-mute, #6b6b6b);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmdk-foot {
  display: flex;
  gap: 1rem;
  padding: 0.5rem 0.9rem;
  border-top: 1px solid var(--color-hair, #e5e2dc);
  font-size: 0.72rem;
  color: var(--color-mute, #6b6b6b);
}
.cmdk-foot kbd {
  font-family: var(--font-mono, monospace);
  font-size: 0.7rem;
  padding: 0.05rem 0.3rem;
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 3px;
  background: var(--color-bg, #faf9f7);
  margin-right: 2px;
}
</style>
