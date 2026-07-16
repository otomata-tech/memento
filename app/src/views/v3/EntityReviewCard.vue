<script setup lang="ts">
/**
 * Memento V3 — carte de Revue d'entités (2e type de Revue, écran 5).
 * Rend UN item de la file `entity_review` (un quasi-doublon détecté : `entity_keep`
 * vs `entity_drop`, jamais fusionné automatiquement — l'humain tranche). Résout les
 * deux UUID en libellés lisibles (apiV3.getEntity, fallback uuid tronqué) et propose
 * deux actions, toutes deux passées par le gate propose → apply :
 *   • Fusionner   → op `merge_entities` { keep, drop } (repointe les mentions, supprime drop)
 *   • Garder distinct → op `confirm_distinct` { a, b } (marque la paire « distincte »)
 * Émet `resolved` après application réussie pour que la liste retire l'item (optimiste).
 */
import { computed, onMounted, ref } from "vue";
import { apiV3 } from "../../api.v3";
import type { EntityType } from "../../api.v3";

/** Un item de la file `entity_review` (cf. apiV3.list("entity_review")). */
export interface EntityReviewItem {
  id: string;
  entity_keep: string;
  entity_drop: string;
  score?: number | null;   // list() caste du `unknown` → peut manquer (computeds défensifs)
  method?: string | null;
  status: string;
}

const props = defineProps<{
  item: EntityReviewItem;
  /** Base active (UUID) — passée au propose pour ne pas fuir hors base. */
  base?: string;
}>();

const emit = defineEmits<{
  /** Émis après application réussie (fusion ou distinction) : la liste retire l'item. */
  resolved: [id: string];
}>();

type ResolvedEntity = { label: string; type: EntityType | null };

const keep = ref<ResolvedEntity | null>(null);
const drop = ref<ResolvedEntity | null>(null);
const resolving = ref(true);

// pending = propose+apply en cours (désactive les boutons). action = laquelle.
const pending = ref<"merge" | "distinct" | null>(null);
const error = ref<string | null>(null);
// Confirmation à deux temps pour la fusion (geste destructif/irréversible, CDC §6).
const confirmMerge = ref(false);

// Score robuste : apiV3.list caste du `unknown` → score peut manquer / être nul.
const scoreNum = computed(() =>
  typeof props.item.score === "number" && Number.isFinite(props.item.score) ? props.item.score : null,
);
const scoreText = computed(() => (scoreNum.value !== null ? scoreNum.value.toFixed(2) : "—"));
const scoreTitle = computed(() =>
  scoreNum.value !== null ? `score ${scoreNum.value.toFixed(3)}` : "score indisponible",
);
const methodText = computed(() => methodLabel(props.item.method, scoreNum.value));

const ENTITY_LABEL: Record<EntityType, string> = {
  personne: "Personne",
  entreprise: "Entreprise",
  outil: "Outil",
  decision: "Décision",
};

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) + "…" : id;
}

/** Résout un UUID en libellé lisible ; fallback sur l'uuid tronqué si l'appel échoue. */
async function resolve(id: string): Promise<ResolvedEntity> {
  try {
    const e = await apiV3.getEntity(id, []);
    return { label: e.canonical_label || shortId(id), type: e.type ?? null };
  } catch {
    return { label: shortId(id), type: null };
  }
}

/** Libellé lisible de la méthode de détection + niveau de confiance (façon écran 5). */
function methodLabel(method: string | null | undefined, score: number | null): string {
  const base =
    method === "knn"
      ? "Similarité sémantique"
      : method === "jaro_winkler"
        ? "Similarité orthographique"
        : method === "lint"
          ? "Lint (quasi-doublon)"
          : method === "adjudicator"
            ? "Arbitrage automatique"
            : (method ?? "méthode inconnue");
  return score === null ? base : `${base} · ${confidenceWord(score)}`;
}

function confidenceWord(score: number): string {
  if (score >= 0.92) return "confiance élevée";
  if (score >= 0.85) return "confiance moyenne";
  return "confiance faible";
}

function fail(e: unknown) {
  error.value = e instanceof Error ? e.message : String(e);
}

/** 1er temps : demande confirmation avant la fusion (destructive). */
function askMerge() {
  if (pending.value) return;
  error.value = null;
  confirmMerge.value = true;
}
function cancelMerge() {
  confirmMerge.value = false;
}

/** 2e temps : fusionne réellement. keep conservé, drop supprimé (mentions repointées). */
async function merge() {
  if (pending.value) return;
  pending.value = "merge";
  error.value = null;
  try {
    const { ingestionId } = await apiV3.propose({
      title: `Fusion d'entités : ${drop.value?.label ?? props.item.entity_drop} → ${keep.value?.label ?? props.item.entity_keep}`,
      base: props.base,
      changes: [
        { op: "merge_entities", payload: { keep: props.item.entity_keep, drop: props.item.entity_drop } },
      ],
    });
    await apiV3.apply(ingestionId);
    emit("resolved", props.item.id);
  } catch (e) {
    fail(e);
  } finally {
    pending.value = null;
    confirmMerge.value = false; // fermé seulement à la fin → « Fusion… » reste visible pendant l'await
  }
}

/** Garde distinct : la paire n'est pas un doublon. */
async function keepDistinct() {
  if (pending.value) return;
  pending.value = "distinct";
  error.value = null;
  try {
    const { ingestionId } = await apiV3.propose({
      title: `Entités distinctes : ${keep.value?.label ?? props.item.entity_keep} / ${drop.value?.label ?? props.item.entity_drop}`,
      base: props.base,
      changes: [
        { op: "confirm_distinct", payload: { a: props.item.entity_keep, b: props.item.entity_drop } },
      ],
    });
    await apiV3.apply(ingestionId);
    emit("resolved", props.item.id);
  } catch (e) {
    fail(e);
  } finally {
    pending.value = null;
  }
}

onMounted(async () => {
  resolving.value = true;
  try {
    [keep.value, drop.value] = await Promise.all([
      resolve(props.item.entity_keep),
      resolve(props.item.entity_drop),
    ]);
  } finally {
    resolving.value = false;
  }
});
</script>

<template>
  <article class="erow" :class="{ busy: pending }">
    <div class="head">
      <span class="badge meth">{{ methodText }}</span>
      <span class="score" :title="scoreTitle">{{ scoreText }}</span>
    </div>

    <p class="lead">Doublon possible — fusionner ou garder distinct&nbsp;?</p>

    <div class="pair">
      <!-- À conserver -->
      <div class="cell keep">
        <span class="role">À conserver</span>
        <span v-if="resolving" class="ent muted">Résolution…</span>
        <template v-else-if="keep">
          <span class="ent">{{ keep.label }}</span>
          <span v-if="keep.type" class="badge etype" :class="keep.type">{{ ENTITY_LABEL[keep.type] }}</span>
        </template>
      </div>

      <span class="arrow" aria-hidden="true">←</span>

      <!-- À fusionner / supprimer -->
      <div class="cell drop">
        <span class="role">À fusionner</span>
        <span v-if="resolving" class="ent muted">Résolution…</span>
        <template v-else-if="drop">
          <span class="ent">{{ drop.label }}</span>
          <span v-if="drop.type" class="badge etype" :class="drop.type">{{ ENTITY_LABEL[drop.type] }}</span>
        </template>
      </div>
    </div>

    <p v-if="error" class="err">{{ error }}</p>

    <!-- Confirmation de fusion (geste destructif/irréversible, CDC §6) -->
    <div v-if="confirmMerge" class="confirm">
      <p class="confirm-text">
        Fusionner <strong>{{ drop?.label ?? "cette entité" }}</strong> dans
        <strong>{{ keep?.label ?? "l'entité conservée" }}</strong> ?
        <strong>{{ drop?.label ?? "L'entité fusionnée" }}</strong> sera supprimée —
        action irréversible.
      </p>
      <div class="confirm-actions">
        <button class="btn primary" :disabled="!!pending" @click="merge">
          {{ pending === "merge" ? "Fusion…" : "Confirmer la fusion" }}
        </button>
        <button class="btn ghost" :disabled="!!pending" @click="cancelMerge">Annuler</button>
      </div>
    </div>

    <div v-else class="actions">
      <button class="btn primary" :disabled="!!pending" @click="askMerge">Fusionner</button>
      <button class="btn ghost" :disabled="!!pending" @click="keepDistinct">
        {{ pending === "distinct" ? "Enregistrement…" : "Garder distinct" }}
      </button>
    </div>
  </article>
</template>

<style scoped>
.erow {
  border: 1px solid var(--color-hair, #e5e2dc);
  background: var(--color-surface, #fff);
  border-radius: 8px;
  padding: 0.85rem 1rem;
  margin-bottom: 0.75rem;
  color: var(--color-ink, #1a1a1a);
}
.erow.busy { opacity: 0.85; }

.head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.badge {
  font-size: 0.7rem;
  letter-spacing: 0.02em;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  border: 1px solid var(--color-hair, #e5e2dc);
  background: var(--color-bg, #faf9f7);
  color: var(--color-mute, #6b6b6b);
}
.badge.meth { text-transform: none; }
.score {
  font-family: var(--font-mono, monospace);
  font-size: 0.75rem;
  color: var(--color-mute, #6b6b6b);
}

.lead {
  margin: 0 0 0.6rem;
  font-size: 0.9rem;
  color: var(--color-mute, #6b6b6b);
}

.pair {
  display: flex;
  align-items: stretch;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.cell {
  flex: 1 1 14rem;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 6px;
  background: var(--color-bg, #faf9f7);
}
.cell.keep { border-left: 3px solid #2f7d46; }
.cell.drop { border-left: 3px solid var(--color-primary, #b5532a); }
.role {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-mute, #6b6b6b);
}
.ent {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.ent.muted { font-weight: 400; color: var(--color-mute, #6b6b6b); }
.arrow {
  align-self: center;
  color: var(--color-mute, #6b6b6b);
  font-size: 1.1rem;
  flex: 0 0 auto;
}

.badge.etype {
  align-self: flex-start;
  border: none;
  color: #fff;
}
.badge.etype.personne { background: #3b6ea5; }
.badge.etype.entreprise { background: #2f8f6b; }
.badge.etype.outil { background: #8a6d3b; }
.badge.etype.decision { background: var(--color-primary, #b5532a); }

.err {
  margin: 0.6rem 0 0;
  background: #fdf2ee;
  border: 1px solid #e8b9a8;
  color: #8a2d10;
  padding: 0.45rem 0.6rem;
  border-radius: 6px;
  font-size: 0.85rem;
}

.confirm {
  margin-top: 0.75rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid #e8b9a8;
  background: #fdf2ee;
  border-radius: 6px;
}
.confirm-text { margin: 0 0 0.6rem; font-size: 0.85rem; line-height: 1.5; color: #7a2a10; }
.confirm-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }

.actions {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}
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
</style>
