<script setup lang="ts">
/**
 * Memento V3 — recherche hybride (sémantique + lexicale) de la base courante.
 * Code contre le contrat figé `api.v3.ts` ; passe TOUJOURS `base: currentBase.value`
 * (sans quoi la recherche fuit sur toutes les bases).
 */
import { ref } from "vue";
import { useRouter } from "vue-router";
import { apiV3 } from "../../api.v3";
import type { SearchHit, EntityRef, Scope } from "../../api.v3";
import { currentBase } from "../../v3/base";

const router = useRouter();

const query = ref("");
const scope = ref<Scope>("savoir");
const hits = ref<SearchHit[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const searched = ref(false);

const SCOPES: { value: Scope; label: string }[] = [
  { value: "savoir", label: "Savoir" },
  { value: "sources", label: "Sources" },
  { value: "both", label: "Les deux" },
];

const ENTITY_LABEL: Record<EntityRef["type"], string> = {
  personne: "Personne",
  entreprise: "Entreprise",
  outil: "Outil",
  decision: "Décision",
};

async function runSearch() {
  const q = query.value.trim();
  if (!q) return;
  loading.value = true;
  error.value = null;
  searched.value = true;
  try {
    hits.value = await apiV3.search(q, {
      base: currentBase.value,
      scope: scope.value,
      limit: 20,
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Erreur de recherche";
    hits.value = [];
  } finally {
    loading.value = false;
  }
}

function openPage(id: string) {
  router.push("/v3/page/" + id);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("fr-FR", { year: "numeric", month: "short", day: "numeric" });
}
</script>

<template>
  <section class="search">
    <form class="bar" @submit.prevent="runSearch">
      <input
        v-model="query"
        class="field"
        type="search"
        placeholder="Rechercher dans la base…"
        autocomplete="off"
        aria-label="Recherche"
      />
      <div class="scope" role="radiogroup" aria-label="Portée">
        <button
          v-for="s in SCOPES"
          :key="s.value"
          type="button"
          class="scope-opt"
          :class="{ active: scope === s.value }"
          :aria-pressed="scope === s.value"
          @click="scope = s.value"
        >
          {{ s.label }}
        </button>
      </div>
      <button type="submit" class="go" :disabled="loading || !query.trim()">
        {{ loading ? "…" : "Rechercher" }}
      </button>
    </form>

    <p v-if="loading" class="state">Recherche en cours…</p>

    <p v-else-if="error" class="state err">{{ error }}</p>

    <p v-else-if="searched && hits.length === 0" class="state">Aucun résultat.</p>

    <div v-else-if="!searched" class="hint">
      <p class="hint-title">Recherche hybride</p>
      <p>
        Combine le sens (sémantique) et les mots exacts (lexical) pour retrouver une
        page même formulée autrement. Tapez une question ou des mots-clés.
      </p>
    </div>

    <ul v-else class="hits">
      <li v-for="hit in hits" :key="hit.pageId" class="hit">
        <button class="title" type="button" @click="openPage(hit.pageId)">
          {{ hit.title || "Sans titre" }}
        </button>

        <p v-if="hit.description" class="desc">{{ hit.description }}</p>

        <blockquote v-if="hit.passage" class="passage">{{ hit.passage }}</blockquote>

        <div class="meta">
          <span
            v-for="m in hit.matchedBy"
            :key="m"
            class="badge match"
            :class="m"
          >{{ m === "semantic" ? "sémantique" : "lexical" }}</span>

          <span v-if="hit.occurredAt" class="date">{{ fmtDate(hit.occurredAt) }}</span>

          <span class="score" :title="'score ' + hit.score.toFixed(3)" aria-hidden="true">●</span>
        </div>

        <ul v-if="hit.entities.length" class="entities">
          <li
            v-for="e in hit.entities"
            :key="e.id"
            class="badge entity"
            :class="e.type"
            :title="ENTITY_LABEL[e.type]"
          >{{ e.label }}</li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.search {
  max-width: 760px;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
  color: var(--color-ink, #1a1a1a);
}

.bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.field {
  flex: 1 1 16rem;
  padding: 0.6rem 0.8rem;
  font-size: 1rem;
  color: var(--color-ink, #1a1a1a);
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 6px;
}
.field:focus {
  outline: none;
  border-color: var(--color-primary, #b5532a);
}

.scope {
  display: inline-flex;
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 6px;
  overflow: hidden;
}
.scope-opt {
  padding: 0.5rem 0.7rem;
  font-size: 0.85rem;
  background: var(--color-surface, #fff);
  color: var(--color-mute, #6b6b6b);
  border: none;
  cursor: pointer;
}
.scope-opt + .scope-opt {
  border-left: 1px solid var(--color-hair, #e5e2dc);
}
.scope-opt.active {
  background: var(--color-primary, #b5532a);
  color: #fff;
}

.go {
  padding: 0.55rem 1.1rem;
  font-size: 0.9rem;
  color: #fff;
  background: var(--color-primary, #b5532a);
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.go:disabled {
  opacity: 0.5;
  cursor: default;
}

.state {
  margin-top: 2rem;
  color: var(--color-mute, #6b6b6b);
}
.state.err {
  color: var(--color-primary, #b5532a);
}

.hint {
  margin-top: 2.5rem;
  padding: 1.2rem 1.4rem;
  background: var(--color-bg, #faf9f7);
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 8px;
  color: var(--color-mute, #6b6b6b);
  line-height: 1.5;
}
.hint-title {
  margin: 0 0 0.4rem;
  font-family: var(--font-display, serif);
  font-size: 1.1rem;
  color: var(--color-ink, #1a1a1a);
}

.hits {
  list-style: none;
  margin: 1.5rem 0 0;
  padding: 0;
}
.hit {
  padding: 1.1rem 0;
  border-bottom: 1px solid var(--color-hair, #e5e2dc);
}

.title {
  display: block;
  padding: 0;
  font-family: var(--font-display, serif);
  font-size: 1.2rem;
  text-align: left;
  color: var(--color-ink, #1a1a1a);
  background: none;
  border: none;
  cursor: pointer;
}
.title:hover {
  color: var(--color-primary, #b5532a);
}

.desc {
  margin: 0.25rem 0 0;
  font-size: 0.9rem;
  color: var(--color-mute, #6b6b6b);
}

.passage {
  margin: 0.6rem 0 0;
  padding: 0.5rem 0.9rem;
  background: var(--color-bg, #faf9f7);
  border-left: 3px solid var(--color-primary, #b5532a);
  border-radius: 0 4px 4px 0;
  font-size: 0.95rem;
  line-height: 1.5;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.6rem;
}

.badge {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  font-size: 0.72rem;
  border-radius: 999px;
  line-height: 1.5;
}

.match {
  border: 1px solid var(--color-hair, #e5e2dc);
  color: var(--color-mute, #6b6b6b);
  background: var(--color-surface, #fff);
}
.match.semantic {
  border-color: var(--color-primary, #b5532a);
  color: var(--color-primary, #b5532a);
}

.date {
  font-size: 0.78rem;
  color: var(--color-mute, #6b6b6b);
}
.score {
  font-size: 0.6rem;
  color: var(--color-hair, #e5e2dc);
}

.entities {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0.55rem 0 0;
  padding: 0;
  list-style: none;
}
.entity {
  color: #fff;
}
.entity.personne {
  background: #3b6ea5;
}
.entity.entreprise {
  background: #2f8f6b;
}
.entity.outil {
  background: #8a6d3b;
}
.entity.decision {
  background: var(--color-primary, #b5532a);
}
</style>
