<script setup lang="ts">
/**
 * Memento V3 — fiche Entité (écran 4). Détail d'une entité de 1er ordre (niveau org) :
 * libellé canonique + type, alias, fiche liée (page) et backlinks « Mentionnée dans ».
 * Lit l'id depuis la route (`/entity/:id`) et recharge au changement d'id.
 * États vide / chargement / erreur de 1re classe (issue #59). Code contre le contrat
 * figé `../../api.v3` ; présentation calquée sur PageReader/SearchView (badges entités).
 */
import { ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiV3 } from "../../api.v3";
import type { EntityDetail, EntityType } from "../../api.v3";

const route = useRoute();
const router = useRouter();

const entity = ref<EntityDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const ENTITY_LABELS: Record<EntityType, string> = {
  personne: "Personne",
  entreprise: "Entreprise",
  outil: "Outil",
  decision: "Décision",
};

async function loadEntity(id: string | null) {
  if (!id) {
    entity.value = null;
    error.value = null;
    return;
  }
  loading.value = true;
  error.value = null;
  entity.value = null;
  try {
    entity.value = await apiV3.getEntity(id, ["backlinks"]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function openPage(id: string) {
  router.push(`/page/${id}`);
}

watch(
  () => route.params.id as string | undefined,
  (id) => loadEntity(id ?? null),
  { immediate: true },
);
</script>

<template>
  <section class="entity">
      <!-- Chargement -->
      <div v-if="loading" class="state muted">Chargement de l'entité…</div>

      <!-- Erreur -->
      <div v-else-if="error" class="state err" role="alert">
        <p class="state-title">Impossible de charger l'entité.</p>
        <p class="small">{{ error }}</p>
      </div>

      <!-- Introuvable -->
      <div v-else-if="!entity" class="state muted">
        <p class="state-title">Entité introuvable.</p>
        <p class="small">Aucune entité ne correspond à cet identifiant.</p>
      </div>

      <!-- Fiche -->
      <article v-else class="card">
        <header class="head">
          <div class="title-row">
            <span class="badge" :class="entity.type" :title="ENTITY_LABELS[entity.type]">
              {{ ENTITY_LABELS[entity.type] }}
            </span>
            <h1 class="title">{{ entity.canonical_label }}</h1>
            <span v-if="entity.is_stub" class="stub" title="Entité non encore consolidée">ébauche</span>
          </div>

          <p v-if="entity.aliases.length" class="aliases">
            <span class="aliases-label">Aussi&nbsp;:</span>
            <span v-for="(a, i) in entity.aliases" :key="i" class="alias">{{ a }}</span>
          </p>
        </header>

        <!-- Fiche liée -->
        <section class="block">
          <h2 class="section-title">Fiche</h2>
          <p v-if="entity.page_id">
            <button type="button" class="link" @click="openPage(entity.page_id)">
              Voir la fiche
            </button>
          </p>
          <p v-else class="empty-inline muted small">
            Aucune fiche liée à cette entité pour l'instant.
          </p>
        </section>

        <!-- Mentionnée dans (backlinks) -->
        <section class="block">
          <h2 class="section-title">Mentionnée dans</h2>
          <ul v-if="entity.mentions?.length" class="mentions">
            <li v-for="(m, i) in entity.mentions" :key="m.page_id + ':' + i" class="mention">
              <button type="button" class="link mention-title" @click="openPage(m.page_id)">
                {{ m.title || "(sans titre)" }}
              </button>
              <span v-if="m.span" class="span muted small">« {{ m.span }} »</span>
            </li>
          </ul>
          <p v-else class="empty-inline muted small">
            Cette entité n'est mentionnée dans aucune page.
          </p>
        </section>
      </article>
  </section>
</template>

<style scoped>
.entity {
  max-width: 760px;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
  color: var(--color-ink, #1a1a1a);
}

/* ── États (chargement / erreur / introuvable) ── */
.state {
  margin-top: 1rem;
  padding: 2.5rem 1.5rem;
  text-align: center;
  border: 1px dashed var(--color-hair, #e5e2dc);
  border-radius: 8px;
  background: var(--color-surface, #fff);
}
.state-title {
  font-family: var(--font-display, serif);
  font-size: 1.2rem;
  margin: 0 0 0.3rem;
  color: var(--color-ink, #1a1a1a);
}
.state.err {
  border-style: solid;
  border-color: #e8b9a8;
  background: #fdf2ee;
  color: #8a2d10;
}
.state.err .state-title { color: #8a2d10; }

/* ── Carte fiche ── */
.card {
  border: 1px solid var(--color-hair, #e5e2dc);
  background: var(--color-surface, #fff);
  border-radius: 8px;
  padding: 1.5rem 1.6rem 1.75rem;
}
.head {
  padding-bottom: 1.1rem;
  border-bottom: 1px solid var(--color-hair, #e5e2dc);
  margin-bottom: 0.25rem;
}
.title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.6rem;
}
.title {
  font-family: var(--font-display, serif);
  font-size: 1.7rem;
  line-height: 1.15;
  margin: 0;
}
.stub {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  background: var(--color-bg, #faf9f7);
  border: 1px solid var(--color-hair, #e5e2dc);
  color: var(--color-mute, #6b6b6b);
}

.aliases {
  margin: 0.7rem 0 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.9rem;
}
.aliases-label { color: var(--color-mute, #6b6b6b); }
.alias {
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: var(--color-bg, #faf9f7);
  border: 1px solid var(--color-hair, #e5e2dc);
  color: var(--color-ink, #1a1a1a);
}

/* ── Blocs (fiche liée / mentions) ── */
.block { margin-top: 1.5rem; }
.section-title {
  font-family: var(--font-display, serif);
  font-size: 0.95rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-mute, #6b6b6b);
  margin: 0 0 0.6rem;
}
.empty-inline { margin: 0; }

.mentions {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.mention {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.mention-title { font-size: 1rem; }
.span { font-style: italic; }

/* ── Liens ── */
.link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  text-align: left;
  color: var(--color-primary, #b5532a);
  cursor: pointer;
  text-decoration: none;
}
.link:hover { text-decoration: underline; }

/* ── Badge type (calque PageReader) ── */
.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}
.badge.personne { background: #e8f0fb; color: #2c5d9b; }
.badge.entreprise { background: #eaf5ec; color: #2f7d46; }
.badge.outil { background: #f3edfb; color: #6b46a8; }
.badge.decision { background: #fbeede; color: #b5532a; }

.muted { color: var(--color-mute, #6b6b6b); }
.small { font-size: 0.8rem; }
</style>
