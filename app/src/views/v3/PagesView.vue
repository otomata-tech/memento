<script setup lang="ts">
/**
 * Memento V3 — lecteur de pages (cœur lecture).
 * Panneau gauche : guide + arbre des pages + entités saillantes.
 * Panneau droit : page sélectionnée (markdown), sources, entités, sous-pages.
 *
 * Sert 2 routes : `/v3` (pas de page → invite) et `/v3/page/:id` (page rendue).
 * Code contre le contrat figé `../../api.v3`.
 */
import { ref, computed, watch, defineComponent, h, type PropType, type Component, type VNode } from "vue";
import { useRoute, useRouter } from "vue-router";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { apiV3 } from "../../api.v3";
import type { TreeNode, PageDetail, EntityRef, EntityType, LoadResult } from "../../api.v3";
import { currentBase } from "../../v3/base";

const route = useRoute();
const router = useRouter();

// ── État épine (load) ─────────────────────────────────────────────────────────
const loadData = ref<LoadResult | null>(null);
const loadError = ref<string | null>(null);
const loadingTree = ref(false);

// ── État page courante (getPage) ──────────────────────────────────────────────
const page = ref<PageDetail | null>(null);
const pageError = ref<string | null>(null);
const loadingPage = ref(false);

const activeId = computed(() => (route.params.id as string | undefined) ?? null);

// ── Chargement de l'épine (arbre + guide + entités) ───────────────────────────
async function loadTree() {
  if (!currentBase.value) {
    loadData.value = null;
    loadError.value = null;
    return;
  }
  loadingTree.value = true;
  loadError.value = null;
  try {
    loadData.value = await apiV3.load(currentBase.value);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
    loadData.value = null;
  } finally {
    loadingTree.value = false;
  }
}

// ── Chargement de la page ─────────────────────────────────────────────────────
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

// ── Rendu markdown sécurisé ───────────────────────────────────────────────────
const renderedBody = computed(() => {
  if (!page.value?.body) return "";
  const html = marked.parse(page.value.body) as string;
  return DOMPurify.sanitize(html);
});

// ── Badges entités ────────────────────────────────────────────────────────────
const ENTITY_LABELS: Record<EntityType, string> = {
  personne: "Personne",
  entreprise: "Entreprise",
  outil: "Outil",
  decision: "Décision",
};
function entityClass(type: EntityType): string {
  return `badge badge-${type}`;
}

// ── Composant récursif d'arbre (render function locale) ───────────────────────
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
    <!-- Panneau gauche : arbre fixe -->
    <aside class="tree-pane">
      <div v-if="loadingTree" class="muted small">Chargement…</div>
      <div v-else-if="loadError" class="error small">{{ loadError }}</div>
      <div v-else-if="!currentBase" class="muted small">Aucune base sélectionnée.</div>
      <template v-else-if="loadData">
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

        <div v-if="loadData.topEntities.length" class="top-entities">
          <h3 class="section-title">Entités saillantes</h3>
          <ul class="entity-list">
            <li v-for="ent in loadData.topEntities" :key="ent.id">
              <span :class="entityClass(ent.type)">{{ ENTITY_LABELS[ent.type] }}</span>
              <span class="entity-label">{{ ent.label }}</span>
            </li>
          </ul>
        </div>

        <div class="counts muted small">
          {{ loadData.counts.pages }} pages · {{ loadData.counts.entities }} entités ·
          {{ loadData.counts.sources }} sources
        </div>
      </template>
    </aside>

    <!-- Panneau droit : lecteur -->
    <main class="reader-pane">
      <div v-if="!activeId" class="placeholder">
        <p>Choisis une page dans l'arbre pour la lire.</p>
      </div>

      <div v-else-if="loadingPage" class="placeholder muted">Chargement de la page…</div>

      <div v-else-if="pageError" class="placeholder error">
        <p>Impossible de charger la page.</p>
        <p class="small">{{ pageError }}</p>
      </div>

      <div v-else-if="!page" class="placeholder muted">Page introuvable.</div>

      <article v-else class="page">
        <div class="breadcrumb small muted">
          <span class="status-pill">{{ page.status }}</span>
          <span class="visibility-pill">{{ page.visibility }}</span>
          <span v-if="page.occurred_at">· {{ page.occurred_at }}</span>
        </div>

        <h1 class="title">{{ page.title }}</h1>
        <p v-if="page.description" class="chapo">{{ page.description }}</p>

        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-if="page.body" class="prose" v-html="renderedBody"></div>

        <!-- Sous-pages -->
        <section v-if="page.children?.length" class="block">
          <h2 class="section-title">Sous-pages</h2>
          <ul class="child-list">
            <li v-for="child in page.children" :key="child.id">
              <button type="button" class="link" @click="openPage(child.id)">{{ child.title }}</button>
              <span v-if="child.description" class="muted small"> — {{ child.description }}</span>
            </li>
          </ul>
        </section>

        <!-- Sources -->
        <section v-if="page.sources?.length" class="block">
          <h2 class="section-title">Sources</h2>
          <ul class="source-list">
            <li v-for="src in page.sources" :key="src.id">
              <a v-if="src.uri" :href="src.uri" target="_blank" rel="noopener noreferrer" class="link">{{
                src.title || src.uri
              }}</a>
              <span v-else class="source-title">{{ src.title || src.kind }}</span>
              <span v-if="src.locator" class="muted small"> ({{ src.locator }})</span>
              <p v-if="src.citation" class="citation muted small">« {{ src.citation }} »</p>
            </li>
          </ul>
        </section>

        <!-- Entités -->
        <section v-if="page.entities?.length" class="block">
          <h2 class="section-title">Entités</h2>
          <ul class="entity-list inline">
            <li v-for="ent in page.entities" :key="ent.id">
              <span :class="entityClass(ent.type)">{{ ENTITY_LABELS[ent.type] }}</span>
              <span class="entity-label">{{ ent.label }}</span>
            </li>
          </ul>
        </section>
      </article>
    </main>
  </div>
</template>

<style scoped>
.pages-view {
  display: flex;
  align-items: stretch;
  height: 100%;
  min-height: 0;
  background: var(--color-bg, #faf9f7);
  color: var(--color-ink, #1a1a1a);
}

/* ── Panneau gauche ── */
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
.tree-item .children {
  margin-left: 0.7rem;
  border-left: 1px solid var(--color-hair, #e5e2dc);
  padding-left: 0.5rem;
}
.node-row {
  display: flex;
  align-items: flex-start; /* le chevron reste en haut sur un titre à 2 lignes */
  gap: 0.3rem;
  border-radius: 5px;
}
.node-row:hover {
  background: var(--color-bg, #f3f1ec);
}
.node-row.active {
  background: color-mix(in srgb, var(--color-primary, #b5532a) 12%, transparent);
}
.node-row.active > .node-label {
  color: var(--color-primary, #b5532a);
  font-weight: 600;
}
.toggle {
  flex: 0 0 0.8rem;
  width: 0.8rem;
  display: flex;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-mute, #6b6b6b);
  font-size: 0.62rem;
  padding: 0.34rem 0 0; /* aligne le chevron sur la 1re ligne du label */
  line-height: 1;
}
.toggle.spacer {
  cursor: default;
}
.node-label {
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
  padding: 0.28rem 0.3rem;
  border-radius: 4px;
  /* titres descriptifs longs : 2 lignes max, ellipsis — compact et scannable */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.top-entities {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--color-hair, #e5e2dc);
}
.counts {
  margin-top: 1.25rem;
}

/* ── Panneau droit ── */
.reader-pane {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 2.5rem 3rem;
}
.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--color-mute, #6b6b6b);
}
.page {
  max-width: 720px;
  margin: 0 auto;
}
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.status-pill,
.visibility-pill {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: var(--color-bg, #faf9f7);
  border: 1px solid var(--color-hair, #e5e2dc);
  text-transform: capitalize;
}
.title {
  font-family: var(--font-display, serif);
  font-size: 2rem;
  line-height: 1.15;
  margin: 0 0 0.75rem;
}
.chapo {
  font-size: 1.1rem;
  line-height: 1.5;
  color: var(--color-mute, #6b6b6b);
  margin: 0 0 1.5rem;
}

.block {
  margin-top: 2rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--color-hair, #e5e2dc);
}
.section-title {
  font-family: var(--font-display, serif);
  font-size: 0.95rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-mute, #6b6b6b);
  margin: 0 0 0.75rem;
}
.child-list,
.source-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.citation {
  margin: 0.25rem 0 0;
  font-style: italic;
}
.link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--color-primary, #b5532a);
  cursor: pointer;
  text-decoration: none;
}
.link:hover {
  text-decoration: underline;
}
.source-title {
  font-weight: 500;
}

/* ── Entités / badges ── */
.entity-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.entity-list.inline {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 0.6rem;
}
.entity-list li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
}
.entity-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
}
.badge-personne {
  background: #e8f0fb;
  color: #2c5d9b;
}
.badge-entreprise {
  background: #eaf5ec;
  color: #2f7d46;
}
.badge-outil {
  background: #f3edfb;
  color: #6b46a8;
}
.badge-decision {
  background: #fbeede;
  color: #b5532a;
}

/* ── Utilitaires ── */
.muted {
  color: var(--color-mute, #6b6b6b);
}
.small {
  font-size: 0.8rem;
}
.error {
  color: #b3261e;
}

/* ── Prose markdown ── */
.prose {
  font-size: 1rem;
  line-height: 1.65;
}
.prose :deep(h1),
.prose :deep(h2),
.prose :deep(h3) {
  font-family: var(--font-display, serif);
  line-height: 1.25;
  margin: 1.6rem 0 0.6rem;
}
.prose :deep(h2) {
  font-size: 1.4rem;
}
.prose :deep(h3) {
  font-size: 1.15rem;
}
.prose :deep(p) {
  margin: 0 0 1rem;
}
.prose :deep(a) {
  color: var(--color-primary, #b5532a);
}
.prose :deep(ul),
.prose :deep(ol) {
  padding-left: 1.4rem;
  margin: 0 0 1rem;
}
.prose :deep(li) {
  margin: 0.25rem 0;
}
.prose :deep(blockquote) {
  margin: 1rem 0;
  padding-left: 1rem;
  border-left: 3px solid var(--color-hair, #e5e2dc);
  color: var(--color-mute, #6b6b6b);
}
.prose :deep(code) {
  background: var(--color-bg, #faf9f7);
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 4px;
  padding: 0.1rem 0.3rem;
  font-size: 0.9em;
}
.prose :deep(pre) {
  background: var(--color-bg, #faf9f7);
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 6px;
  padding: 1rem;
  overflow-x: auto;
}
.prose :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
}
.prose :deep(img) {
  max-width: 100%;
}
.prose :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 1rem;
}
.prose :deep(th),
.prose :deep(td) {
  border: 1px solid var(--color-hair, #e5e2dc);
  padding: 0.4rem 0.6rem;
  text-align: left;
}
</style>
