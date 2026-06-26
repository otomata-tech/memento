<script setup lang="ts">
/**
 * Memento V3 — viewer de pages ADAPTATIF (cœur lecture).
 *
 * Deux dispositions de navigation, choisies selon la TAILLE de la base :
 *  - **Rail** (petites/moyennes KB) : arbre repliable à gauche + lecteur à droite.
 *  - **Colonnes** (grandes/profondes KB) : navigation Miller (colonnes en cascade le long
 *    du chemin de la page active) + lecteur à droite — garde le contexte de profondeur.
 * Mode effectif `auto` par défaut : > RAIL_MAX pages ⇒ colonnes, sinon rail. Un switch
 * manuel (Auto/Rail/Colonnes) force la disposition ; le choix est persisté (localStorage).
 *
 * Le LECTEUR (PageReader) est partagé par les deux modes. Les colonnes dérivent du chemin
 * de la page active (route-driven) → pas d'état de sélection en double.
 *
 * Sert 2 routes : `/v3` (pas de page → invite) et `/v3/page/:id` (page rendue).
 * Code contre le contrat figé `../../api.v3`.
 */
import { ref, computed, watch, defineComponent, h, type PropType, type Component, type VNode } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiV3 } from "../../api.v3";
import type { TreeNode, PageDetail, LoadResult } from "../../api.v3";
import { currentBase, currentBaseRef } from "../../v3/base";
import PageReader from "./PageReader.vue";

const route = useRoute();
const router = useRouter();

// ── Disposition adaptative ──────────────────────────────────────────────────────
// Au-delà de ce nombre de pages, `auto` bascule rail → colonnes (un arbre plat devient
// peu lisible ; la navigation Miller garde le contexte sur les arbres profonds).
const RAIL_MAX = 40;
type ViewMode = "auto" | "rail" | "colonnes";
const VIEWMODE_LS = "memento.v3.viewmode";
const MODES: { v: ViewMode; label: string }[] = [
  { v: "auto", label: "Auto" }, { v: "rail", label: "Rail" }, { v: "colonnes", label: "Colonnes" },
];
const mode = ref<ViewMode>((localStorage.getItem(VIEWMODE_LS) as ViewMode) || "auto");
function setMode(m: ViewMode) {
  mode.value = m;
  localStorage.setItem(VIEWMODE_LS, m);
}

// ── État épine (load) + page courante (getPage) ───────────────────────────────
const loadData = ref<LoadResult | null>(null);
const loadError = ref<string | null>(null);
const loadingTree = ref(false);
const page = ref<PageDetail | null>(null);
const pageError = ref<string | null>(null);
const loadingPage = ref(false);

const activeId = computed(() => (route.params.id as string | undefined) ?? null);

// Nombre total de pages accessibles (indépendant de la profondeur chargée) = la mesure
// de taille qui pilote `auto`.
const pageCount = computed(() => loadData.value?.counts.pages ?? 0);
const effMode = computed<"rail" | "colonnes">(() =>
  mode.value === "auto" ? (pageCount.value > RAIL_MAX ? "colonnes" : "rail") : mode.value,
);
const effMeta = computed(
  () => `${mode.value === "auto" ? "Auto" : "Manuel"} · ${effMode.value === "rail" ? "Rail" : "Colonnes"} · ${pageCount.value} p.`,
);

// ── Chargements ───────────────────────────────────────────────────────────────
// Profondeur 4 (max du contrat) : nourrit la navigation Miller sans re-fetch et
// donne un arbre plus complet au mode rail.
async function loadTree() {
  if (!currentBase.value) {
    loadData.value = null;
    loadError.value = null;
    return;
  }
  loadingTree.value = true;
  loadError.value = null;
  try {
    loadData.value = await apiV3.load(currentBase.value, 4);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
    loadData.value = null;
  } finally {
    loadingTree.value = false;
  }
}

async function loadPage(id: string | null) {
  if (!id) {
    page.value = null;
    pageError.value = null;
    return;
  }
  loadingPage.value = true;
  pageError.value = null;
  page.value = null;
  try {
    page.value = await apiV3.getPage(id);
  } catch (e) {
    pageError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loadingPage.value = false;
  }
}

watch(currentBase, () => loadTree(), { immediate: true });
watch(activeId, (id) => loadPage(id), { immediate: true });

function openPage(id: string) {
  router.push(`/v3/page/${id}`);
}

// ── Navigation Miller (colonnes) ──────────────────────────────────────────────
// Chemin racine→page active (inclus) dans l'arbre courant ; les colonnes en dérivent.
function pathTo(nodes: TreeNode[], id: string): TreeNode[] | null {
  for (const n of nodes) {
    if (n.id === id) return [n];
    if (n.children?.length) {
      const sub = pathTo(n.children, id);
      if (sub) return [n, ...sub];
    }
  }
  return null;
}
const colPathNodes = computed<TreeNode[]>(() => {
  const id = activeId.value;
  if (!id || !loadData.value) return [];
  return pathTo(loadData.value.tree, id) ?? [];
});
interface Column { label: string; nodes: TreeNode[]; activeId: string | null }
const columns = computed<Column[]>(() => {
  const data = loadData.value;
  if (!data) return [];
  const path = colPathNodes.value;
  const cols: Column[] = [{ label: "Sections", nodes: data.tree, activeId: path[0]?.id ?? null }];
  for (let i = 0; i < path.length; i++) {
    const n = path[i];
    if (n.children?.length) cols.push({ label: "Sous-pages", nodes: n.children, activeId: path[i + 1]?.id ?? null });
  }
  return cols;
});
const baseShort = computed(() => (currentBaseRef()?.name ?? "").split(" — ")[0]);
const breadcrumb = computed(() => colPathNodes.value.map((n) => n.title || "(sans titre)"));

// ── Composant récursif d'arbre (mode rail) ────────────────────────────────────
const TreeItem = defineComponent({
  name: "TreeItem",
  props: {
    node: { type: Object as PropType<TreeNode>, required: true },
    activeId: { type: String as PropType<string | null>, default: null },
    depth: { type: Number, default: 0 },
  },
  emits: { select: (_id: string) => true },
  setup(props, { emit }) {
    const open = ref(true);
    const hasChildren = computed(() => !!props.node.children?.length);
    const isActive = computed(() => props.node.id === props.activeId);

    return (): VNode =>
      h("div", { class: "tree-item" }, [
        h("div", { class: ["node-row", { active: isActive.value }] }, [
          hasChildren.value
            ? h(
                "button",
                {
                  class: "toggle",
                  type: "button",
                  onClick: (e: MouseEvent) => {
                    e.stopPropagation();
                    open.value = !open.value;
                  },
                  "aria-label": open.value ? "Replier" : "Déplier",
                },
                open.value ? "▾" : "▸",
              )
            : h("span", { class: "toggle spacer" }),
          h(
            "button",
            {
              class: "node-label",
              type: "button",
              title: props.node.description || props.node.title,
              onClick: () => emit("select", props.node.id),
            },
            props.node.title || "(sans titre)",
          ),
        ]),
        hasChildren.value && open.value
          ? h(
              "div",
              { class: "children" },
              props.node.children!.map((child) =>
                h(TreeItem as Component, {
                  key: child.id,
                  node: child,
                  activeId: props.activeId,
                  depth: props.depth + 1,
                  onSelect: (id: string) => emit("select", id),
                }),
              ),
            )
          : null,
      ]);
  },
});
</script>

<template>
  <div class="pages-view">
    <!-- ── Barre de disposition (mode adaptatif + switch manuel) ── -->
    <div class="viewbar">
      <span class="meta mono">{{ effMeta }}</span>
      <div class="seg" role="group" aria-label="Disposition">
        <span class="seg-label mono">Vue</span>
        <button
          v-for="m in MODES"
          :key="m.v"
          type="button"
          class="seg-btn"
          :class="{ on: mode === m.v }"
          @click="setMode(m.v)"
        >
          {{ m.label }}
        </button>
      </div>
    </div>

    <!-- États globaux -->
    <div v-if="loadingTree" class="pane-state muted small">Chargement…</div>
    <div v-else-if="loadError" class="pane-state error small">{{ loadError }}</div>
    <div v-else-if="!currentBase" class="pane-state muted small">Aucune base sélectionnée.</div>

    <!-- ════════ MODE RAIL ════════ -->
    <div v-else-if="effMode === 'rail'" class="pane-row">
      <aside class="tree-pane">
        <template v-if="loadData">
          <p v-if="loadData.guide" class="guide">{{ loadData.guide }}</p>

          <nav class="tree">
            <TreeItem
              v-for="node in loadData.tree"
              :key="node.id"
              :node="node"
              :active-id="activeId"
              @select="openPage"
            />
            <p v-if="!loadData.tree.length" class="muted small">Aucune page.</p>
          </nav>

          <div class="counts muted small">
            {{ loadData.counts.pages }} pages · {{ loadData.counts.entities }} entités ·
            {{ loadData.counts.sources }} sources
          </div>
        </template>
      </aside>

      <PageReader
        :page="page"
        :loading="loadingPage"
        :error="pageError"
        :has-selection="!!activeId"
        @open="openPage"
      />
    </div>

    <!-- ════════ MODE COLONNES (Miller) ════════ -->
    <div v-else class="pane-row cols-mode">
      <div class="crumbs mono">
        <span class="crumb-base">{{ baseShort }}</span>
        <template v-for="(c, i) in breadcrumb" :key="i">
          <span class="crumb-sep">▸</span>
          <span class="crumb">{{ c }}</span>
        </template>
      </div>
      <div class="cols-body">
        <div v-if="loadData" class="cols">
          <div v-for="(col, ci) in columns" :key="ci" class="col">
            <div class="col-head mono">{{ col.label }}</div>
            <button
              v-for="n in col.nodes"
              :key="n.id"
              type="button"
              class="col-row"
              :class="{ on: n.id === col.activeId }"
              :title="n.description || n.title"
              @click="openPage(n.id)"
            >
              <span class="col-title">{{ n.title || "(sans titre)" }}</span>
              <span v-if="n.children?.length" class="col-chev">›</span>
              <span v-if="n.children?.length" class="col-meta mono">{{ n.children.length }} sous-pages</span>
            </button>
            <p v-if="!col.nodes.length" class="muted small col-empty">Vide.</p>
          </div>
        </div>
        <PageReader
          :page="page"
          :loading="loadingPage"
          :error="pageError"
          :has-selection="!!activeId"
          :bordered="true"
          @open="openPage"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.pages-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--color-bg, #faf9f7);
  color: var(--color-ink, #1a1a1a);
}

/* ── Barre de disposition ── */
.viewbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--color-hair, #e5e2dc);
  background: var(--color-surface, #fff);
}
.viewbar .meta {
  font-size: 11px;
  color: var(--color-mute, #6b6b6b);
  white-space: nowrap;
}
.seg {
  margin-left: auto;
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--color-hair, #e5e2dc);
  background: var(--color-bg, #faf9f7);
}
.seg-label {
  display: flex;
  align-items: center;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-mute, #6b6b6b);
  padding: 0 9px;
  border-right: 1px solid var(--color-hair, #e5e2dc);
}
.seg-btn {
  font: inherit;
  font-size: 12px;
  padding: 5px 12px;
  border: none;
  border-left: 1px solid var(--color-hair, #e5e2dc);
  background: transparent;
  color: var(--color-mute, #6b6b6b);
  cursor: pointer;
}
.seg-btn:first-of-type { border-left: none; }
.seg-btn:hover { background: var(--color-bg, #f3f1ec); }
.seg-btn.on {
  background: var(--color-primary, #b5532a);
  color: var(--color-primary-ink, #fff);
  font-weight: 600;
}

.pane-state { padding: 1.25rem 1rem; }
.pane-row {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
}

/* ── Mode rail : panneau gauche ── */
.tree-pane {
  width: 300px;
  flex: 0 0 300px;
  overflow-y: auto;
  padding: 1.25rem 1rem;
  border-right: 1px solid var(--color-hair, #e5e2dc);
  background: var(--color-surface, #fff);
}
.guide {
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--color-mute, #6b6b6b);
  margin: 0 0 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--color-hair, #e5e2dc);
}
.tree {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tree :deep(.children) {
  margin-left: 0.6rem;
  border-left: 1px solid var(--color-hair, #e5e2dc);
  padding-left: 0.45rem;
}
.tree :deep(.node-row) {
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
  border-radius: 5px;
}
.tree :deep(.node-row:hover) {
  background: var(--color-bg, #f3f1ec);
}
.tree :deep(.node-row.active) {
  background: color-mix(in srgb, var(--color-primary, #b5532a) 12%, transparent);
}
.tree :deep(.node-row.active > .node-label) {
  color: var(--color-primary, #b5532a);
  font-weight: 600;
}
.tree :deep(.toggle) {
  flex: 0 0 0.85rem;
  width: 0.85rem;
  display: flex;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-mute, #6b6b6b);
  font-size: 0.6rem;
  padding: 0.36rem 0 0;
  line-height: 1;
}
.tree :deep(.toggle.spacer) {
  cursor: default;
}
.tree :deep(.node-label) {
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  font-size: 0.82rem;
  line-height: 1.32;
  color: var(--color-ink, #1a1a1a);
  padding: 0.26rem 0.3rem;
  border-radius: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.counts {
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid var(--color-hair, #e5e2dc);
}

/* ── Mode colonnes (Miller) ── */
.cols-mode { flex-direction: column; }
.crumbs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 16px;
  border-bottom: 1px solid var(--color-hair, #e5e2dc);
  background: var(--color-bg, #faf9f7);
  font-size: 11.5px;
  color: var(--color-mute, #6b6b6b);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.crumb-base { color: var(--color-mute, #6b6b6b); }
.crumb-sep { color: var(--color-hair, #dccfa8); }
.crumb { color: var(--color-ink, #2c2112); }
.crumb:last-child { font-weight: 600; }
.cols-body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
}
.cols {
  display: flex;
  flex: 0 1 auto;
  max-width: 62%;
  overflow-x: auto;
  min-width: 0;
}
.col {
  width: 244px;
  flex: none;
  border-right: 1px solid var(--color-hair, #e5e2dc);
  overflow-y: auto;
  background: var(--color-surface, #fff);
}
.col-head {
  padding: 11px 14px 7px;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-mute, #6b6b6b);
}
.col-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  width: 100%;
  text-align: left;
  border: none;
  border-left: 3px solid transparent;
  background: transparent;
  padding: 9px 13px;
  cursor: pointer;
  font: inherit;
}
.col-row:hover { background: var(--color-bg, #f3f1ec); }
.col-row.on {
  border-left-color: var(--color-primary, #b5532a);
  background: color-mix(in srgb, var(--color-primary, #b5532a) 10%, transparent);
}
.col-title {
  font-size: 13px;
  line-height: 1.3;
  color: var(--color-ink, #2c2112);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-row.on .col-title { font-weight: 600; color: var(--color-primary, #b5532a); }
.col-chev { color: var(--color-mute, #6b6b6b); font-size: 14px; padding-left: 6px; }
.col-meta {
  grid-column: 1 / -1;
  font-size: 10px;
  color: var(--color-mute, #6b6b6b);
  margin-top: 2px;
}
.col-empty { padding: 9px 14px; }

/* ── Utilitaires ── */
.mono { font-family: var(--font-mono, ui-monospace, monospace); }
.muted { color: var(--color-mute, #6b6b6b); }
.small { font-size: 0.8rem; }
.error { color: #b3261e; }
</style>
