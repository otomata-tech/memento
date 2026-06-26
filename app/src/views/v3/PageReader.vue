<script setup lang="ts">
/**
 * Memento V3 — lecteur de page (panneau droit), partagé par les dispositions rail et
 * colonnes de PagesView. Présentation pure : reçoit la page (getPage) + l'état de
 * chargement, émet `open` pour naviguer vers une sous-page. Markdown sanitisé.
 */
import { computed } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { PageDetail, EntityType } from "../../api.v3";

const props = defineProps<{
  page: PageDetail | null;
  loading: boolean;
  error: string | null;
  hasSelection: boolean;
  bordered?: boolean;
}>();
const emit = defineEmits<{ open: [id: string] }>();

const renderedBody = computed(() => {
  if (!props.page?.body) return "";
  const html = marked.parse(props.page.body) as string;
  return DOMPurify.sanitize(html);
});

const ENTITY_LABELS: Record<EntityType, string> = {
  personne: "Personne",
  entreprise: "Entreprise",
  outil: "Outil",
  decision: "Décision",
};
function entityClass(type: EntityType): string {
  return `badge badge-${type}`;
}
</script>

<template>
  <main class="reader-pane" :class="{ bordered }">
    <div v-if="!hasSelection" class="placeholder">
      <p>Choisis une page pour la lire.</p>
    </div>

    <div v-else-if="loading" class="placeholder muted">Chargement de la page…</div>

    <div v-else-if="error" class="placeholder error">
      <p>Impossible de charger la page.</p>
      <p class="small">{{ error }}</p>
    </div>

    <div v-else-if="!page" class="placeholder muted">Page introuvable.</div>

    <article v-else class="page">
      <div class="topline small muted">
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
            <button type="button" class="link" @click="emit('open', child.id)">{{ child.title }}</button>
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
</template>

<style scoped>
.reader-pane {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 2.5rem 3rem;
}
.reader-pane.bordered { border-left: 1px solid var(--color-hair, #e5e2dc); }
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
.topline {
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
.badge-personne { background: #e8f0fb; color: #2c5d9b; }
.badge-entreprise { background: #eaf5ec; color: #2f7d46; }
.badge-outil { background: #f3edfb; color: #6b46a8; }
.badge-decision { background: #fbeede; color: #b5532a; }

.muted { color: var(--color-mute, #6b6b6b); }
.small { font-size: 0.8rem; }
.error { color: #b3261e; }

/* ── Prose markdown ── */
.prose { font-size: 1rem; line-height: 1.65; }
.prose :deep(h1),
.prose :deep(h2),
.prose :deep(h3) {
  font-family: var(--font-display, serif);
  line-height: 1.25;
  margin: 1.6rem 0 0.6rem;
}
.prose :deep(h2) { font-size: 1.4rem; }
.prose :deep(h3) { font-size: 1.15rem; }
.prose :deep(p) { margin: 0 0 1rem; }
.prose :deep(a) { color: var(--color-primary, #b5532a); }
.prose :deep(ul),
.prose :deep(ol) { padding-left: 1.4rem; margin: 0 0 1rem; }
.prose :deep(li) { margin: 0.25rem 0; }
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
.prose :deep(pre code) { background: none; border: none; padding: 0; }
.prose :deep(img) { max-width: 100%; }
.prose :deep(table) { border-collapse: collapse; width: 100%; margin: 0 0 1rem; }
.prose :deep(th),
.prose :deep(td) {
  border: 1px solid var(--color-hair, #e5e2dc);
  padding: 0.4rem 0.6rem;
  text-align: left;
}
</style>
