<script setup lang="ts">
/**
 * Memento V3 — panneau Partage d'une page (wireframe écran 6).
 * Ouvert depuis le lecteur (PageReader) : règle la visibilité (privé/org/public),
 * invite un utilisateur par email (lecture/écriture), copie le lien de la page.
 *
 * Fait (issue #73) :
 *  - visibilité   → share(pageId, { visibility })
 *  - invitation   → share(pageId, { user: email, mode }) + écho `resolved` (flash exact)
 *  - Qui a accès  → get(include:'grants') : liste + changement de mode + révocation
 *                   (share({ mode:'none' })). `grants=null` ⟹ pas d'autorité de gestion.
 *
 * Passer en PUBLIC est un geste sensible (CDC §6) → confirmation explicite avant l'appel.
 * Présentation alignée sur les vues v3 (mêmes tokens, .btn/.primary/.ghost), styles scoped.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { apiV3, type Visibility, type GrantMode, type PageGrant } from "../../api.v3";

const props = defineProps<{
  pageId: string;
  currentVisibility: Visibility;
  /** Mode Solo (org personnelle, pas d'équipe) → masque le partage « org ». */
  soloMode?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  /** Émis après un changement appliqué (visibilité posée OU invitation envoyée). */
  updated: [visibility: Visibility];
}>();

// ── Visibilité (optimiste, réconciliée sur erreur) ──────────────────────────────
const visibility = ref<Visibility>(props.currentVisibility);
// Re-synchronise si la page change sous le panneau (parent qui re-fetch).
watch(() => props.currentVisibility, (v) => { visibility.value = v; });

const VIS: { value: Visibility; label: string; hint: string }[] = [
  { value: "private", label: "Privé", hint: "Accès explicite seulement (toi + invités)." },
  { value: "org", label: "Organisation", hint: "Tous les membres de l'organisation." },
  { value: "public", label: "Public", hint: "Accessible par lien seul, non listée ni cherchable." },
];
const visOptions = computed(() => props.soloMode ? VIS.filter((o) => o.value !== "org") : VIS);

const visBusy = ref(false);
const visError = ref<string | null>(null);
// Visibilité en attente de confirmation (uniquement « public », geste sensible).
const pendingPublic = ref(false);

function onPickVisibility(v: Visibility) {
  if (v === visibility.value || visBusy.value) return;
  visError.value = null;
  if (v === "public") { pendingPublic.value = true; return; }
  pendingPublic.value = false;
  void setVisibility(v);
}

function cancelPublic() { pendingPublic.value = false; }

async function setVisibility(v: Visibility) {
  if (visBusy.value) return;
  const previous = visibility.value;
  visBusy.value = true;
  visError.value = null;
  visibility.value = v;          // optimiste
  pendingPublic.value = false;
  try {
    await apiV3.share(props.pageId, { visibility: v });
    flash(`Visibilité réglée sur « ${visLabel(v)} ».`);
    emit("updated", v);
  } catch (e) {
    visibility.value = previous;  // réconcilie
    visError.value = e instanceof Error ? e.message : String(e);
  } finally {
    visBusy.value = false;
  }
}

function visLabel(v: Visibility): string {
  return VIS.find((o) => o.value === v)?.label ?? v;
}

// ── Invitation d'un utilisateur ─────────────────────────────────────────────────
const inviteEmail = ref("");
const inviteMode = ref<GrantMode>("read");
const inviteBusy = ref(false);
const inviteError = ref<string | null>(null);

const MODES: { value: GrantMode; label: string }[] = [
  { value: "read", label: "Lecture" },
  { value: "write", label: "Écriture" },
];

async function inviteUser() {
  const email = inviteEmail.value.trim();
  if (!email || inviteBusy.value) return;
  inviteBusy.value = true;
  inviteError.value = null;
  try {
    const { resolved } = await apiV3.share(props.pageId, { user: email, mode: inviteMode.value });
    const acc = inviteMode.value === "read" ? "lecture" : "écriture";
    // Flash EXACT dérivé de l'écho serveur : compte créé / invitation en attente /
    // accès accordé à un membre existant (issue #73, plus d'optimisme aveugle).
    if (resolved?.provisioned) flash(`${email} — compte créé, invitation envoyée (${acc}).`);
    else if (resolved?.pending) flash(`${email} — invitation en attente, accès prêt (${acc}).`);
    else flash(`${email} — accès accordé (${acc}).`);
    inviteEmail.value = "";
    await loadGrants(); // le nouvel accès apparaît dans « Qui a accès »
    // Pas d'emit "updated" : une invitation ne change pas la visibilité de la page
    // → le panneau reste ouvert pour enchaîner plusieurs invitations.
  } catch (e) {
    inviteError.value = e instanceof Error ? e.message : String(e);
  } finally {
    inviteBusy.value = false;
  }
}

// ── « Qui a accès » : liste des grants + révocation / changement de mode ─────────
// grants = null → l'appelant ne peut PAS gérer le partage (write) ; [] → personne.
const grants = ref<PageGrant[] | null>(null);
const grantsLoaded = ref(false);
const grantsError = ref<string | null>(null);
const grantBusy = ref<string | null>(null); // userId en cours de mutation
const canManage = computed(() => grantsLoaded.value && grants.value !== null);

async function loadGrants() {
  grantsError.value = null;
  try {
    grants.value = await apiV3.pageGrants(props.pageId);
  } catch (e) {
    grantsError.value = e instanceof Error ? e.message : String(e);
  } finally {
    grantsLoaded.value = true;
  }
}

async function revokeGrant(g: PageGrant) {
  if (grantBusy.value) return;
  grantBusy.value = g.userId;
  grantsError.value = null;
  try {
    await apiV3.share(props.pageId, { user: g.userId, mode: "none" });
    flash(`Accès retiré à ${g.email ?? g.userId}.`);
    await loadGrants();
  } catch (e) {
    grantsError.value = e instanceof Error ? e.message : String(e);
  } finally {
    grantBusy.value = null;
  }
}

async function changeGrantMode(g: PageGrant, mode: GrantMode) {
  if (grantBusy.value || mode === g.mode) return;
  grantBusy.value = g.userId;
  grantsError.value = null;
  try {
    await apiV3.share(props.pageId, { user: g.userId, mode });
    flash(`${g.email ?? g.userId} → ${mode === "read" ? "lecture" : "écriture"}.`);
    await loadGrants();
  } catch (e) {
    grantsError.value = e instanceof Error ? e.message : String(e);
  } finally {
    grantBusy.value = null;
  }
}

// ── Copier le lien ──────────────────────────────────────────────────────────────
const pageUrl = computed(() => {
  const { origin } = window.location;
  return `${origin}/v3/page/${props.pageId}`;
});
const copied = ref(false);

async function copyLink() {
  try {
    await navigator.clipboard.writeText(pageUrl.value);
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    // Pas de presse-papiers : le champ reste sélectionnable manuellement.
    flash("Sélectionne le lien et copie-le manuellement.");
  }
}

// ── Flash transverse (succès inline) ────────────────────────────────────────────
const flashMsg = ref<string | null>(null);
function flash(msg: string) {
  flashMsg.value = msg;
  window.setTimeout(() => { if (flashMsg.value === msg) flashMsg.value = null; }, 3000);
}

// ── Modale accessible : Échap pour fermer, focus initial/restitué, piège de focus ──
const panelEl = ref<HTMLElement | null>(null);
let previouslyFocused: HTMLElement | null = null;

function focusables(): HTMLElement[] {
  if (!panelEl.value) return [];
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(panelEl.value.querySelectorAll<HTMLElement>(sel)).filter((el) => el.offsetParent !== null);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
    return;
  }
  if (e.key !== "Tab") return;
  const els = focusables();
  if (els.length === 0) return;
  const first = els[0];
  const last = els[els.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  previouslyFocused = document.activeElement as HTMLElement | null;
  document.addEventListener("keydown", onKeydown);
  void loadGrants();
  await nextTick();
  focusables()[0]?.focus();
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  previouslyFocused?.focus();
});
</script>

<template>
  <div class="share-overlay" @click.self="emit('close')">
    <aside ref="panelEl" class="share-panel" role="dialog" aria-modal="true" aria-label="Partager la page">
      <header class="sp-head">
        <h2>Partager</h2>
        <button type="button" class="sp-close" aria-label="Fermer" @click="emit('close')">✕</button>
      </header>

      <p v-if="flashMsg" class="sp-flash" role="status" aria-live="polite">{{ flashMsg }}</p>

      <!-- ── Visibilité ── -->
      <section class="sp-section">
        <h3 class="sp-title">Visibilité</h3>
        <div class="vis-options" role="radiogroup" aria-label="Visibilité de la page">
          <button
            v-for="opt in visOptions"
            :key="opt.value"
            type="button"
            class="vis-opt"
            :class="{ on: visibility === opt.value }"
            role="radio"
            :aria-checked="visibility === opt.value"
            :disabled="visBusy"
            @click="onPickVisibility(opt.value)"
          >
            <span class="vis-radio" aria-hidden="true"></span>
            <span class="vis-text">
              <span class="vis-label">{{ opt.label }}</span>
              <span class="vis-hint">{{ opt.hint }}</span>
            </span>
          </button>
        </div>

        <!-- Confirmation passage en public (geste sensible, CDC §6) -->
        <div v-if="pendingPublic" class="sp-confirm">
          <p class="sp-confirm-text">
            Rendre cette page <strong>publique</strong> ? Elle sera
            <strong>accessible par lien seul</strong> — non listée ni cherchable —
            mais lisible par toute personne disposant de l'URL.
          </p>
          <div class="sp-confirm-actions">
            <button type="button" class="btn primary" :disabled="visBusy" @click="setVisibility('public')">
              Rendre public
            </button>
            <button type="button" class="btn ghost" :disabled="visBusy" @click="cancelPublic">Annuler</button>
          </div>
        </div>

        <p v-if="visBusy" class="sp-state muted small">Mise à jour…</p>
        <p v-if="visError" class="sp-err" role="alert">{{ visError }}</p>
      </section>

      <!-- ── Inviter un utilisateur ── -->
      <section class="sp-section">
        <h3 class="sp-title">Inviter une personne</h3>
        <p class="muted small sp-sub">Donne un accès individuel par email, en plus de la visibilité.</p>
        <form class="invite-form" @submit.prevent="inviteUser">
          <input
            v-model="inviteEmail"
            class="inp"
            type="email"
            placeholder="email@exemple.com"
            autocomplete="off"
            required
          />
          <select v-model="inviteMode" class="sel" aria-label="Niveau d'accès">
            <option v-for="m in MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select>
          <button type="submit" class="btn primary" :disabled="inviteBusy || !inviteEmail.trim()">
            {{ inviteBusy ? "…" : "Inviter" }}
          </button>
        </form>
        <p v-if="inviteError" class="sp-err" role="alert">{{ inviteError }}</p>
      </section>

      <!-- ── Qui a accès (liste + révocation + changement de mode) ── -->
      <section class="sp-section">
        <h3 class="sp-title">Qui a accès</h3>
        <p v-if="!grantsLoaded" class="sp-state muted small">Chargement…</p>
        <p v-else-if="grantsError" class="sp-err" role="alert">{{ grantsError }}</p>
        <p v-else-if="!canManage" class="muted small">
          Tu n'as pas les droits de gestion du partage de cette page.
        </p>
        <p v-else-if="grants && grants.length === 0" class="muted small">
          Aucun accès individuel. La page reste visible selon sa visibilité ci-dessus.
        </p>
        <ul v-else class="grant-list">
          <li v-for="g in grants" :key="g.userId" class="grant-row">
            <span class="grant-who">
              <span class="grant-email">{{ g.email ?? g.userId }}</span>
              <span v-if="g.pending" class="grant-pending" title="Compte invité, jamais connecté">en attente</span>
            </span>
            <select
              class="sel grant-mode"
              :value="g.mode"
              :disabled="grantBusy === g.userId"
              aria-label="Niveau d'accès"
              @change="(e) => changeGrantMode(g, (e.target as HTMLSelectElement).value as GrantMode)"
            >
              <option v-for="m in MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
            <button
              type="button"
              class="btn ghost grant-revoke"
              :disabled="grantBusy === g.userId"
              @click="revokeGrant(g)"
            >
              {{ grantBusy === g.userId ? "…" : "Retirer" }}
            </button>
          </li>
        </ul>
      </section>

      <!-- ── Lien de la page ── -->
      <section class="sp-section">
        <h3 class="sp-title">Lien de la page</h3>
        <div class="link-row">
          <input
            class="inp link-field"
            :value="pageUrl"
            readonly
            aria-label="Lien de la page"
            @focus="(e) => (e.target as HTMLInputElement).select()"
          />
          <button type="button" class="btn" @click="copyLink">{{ copied ? "Copié ✓" : "Copier" }}</button>
        </div>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.share-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  justify-content: flex-end;
  background: rgba(26, 26, 26, 0.32);
}
.share-panel {
  width: 100%;
  max-width: 420px;
  height: 100%;
  overflow-y: auto;
  background: var(--color-surface, #fff);
  border-left: 1px solid var(--color-hair, #e5e2dc);
  box-shadow: -6px 0 24px rgba(0, 0, 0, 0.08);
  padding: 1.5rem 1.5rem 2.5rem;
  color: var(--color-ink, #1a1a1a);
}

.sp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
}
.sp-head h2 {
  font-family: var(--font-display, serif);
  font-size: 1.35rem;
  margin: 0;
}
.sp-close {
  background: none;
  border: none;
  font-size: 1rem;
  line-height: 1;
  color: var(--color-mute, #6b6b6b);
  cursor: pointer;
  padding: 0.25rem 0.4rem;
}
.sp-close:hover { color: var(--color-ink, #1a1a1a); }

.sp-section {
  padding: 1.1rem 0;
  border-top: 1px solid var(--color-hair, #e5e2dc);
}
.sp-section:first-of-type { border-top: none; padding-top: 0; }
.sp-title {
  font-family: var(--font-display, serif);
  font-size: 0.95rem;
  margin: 0 0 0.6rem;
}
.sp-sub { margin: -0.3rem 0 0.7rem; }

/* ── Visibilité ── */
.vis-options { display: flex; flex-direction: column; gap: 0.4rem; }
.vis-opt {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  width: 100%;
  text-align: left;
  font: inherit;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 8px;
  background: var(--color-bg, #faf9f7);
  color: var(--color-ink, #1a1a1a);
  cursor: pointer;
}
.vis-opt:hover { border-color: var(--color-mute, #b8b2a8); }
.vis-opt.on {
  border-color: var(--color-primary, #b5532a);
  background: color-mix(in srgb, var(--color-primary, #b5532a) 8%, transparent);
}
.vis-opt:disabled { opacity: 0.6; cursor: default; }
.vis-radio {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-top: 0.15rem;
  border-radius: 999px;
  border: 2px solid var(--color-hair, #cfc8bc);
  background: var(--color-surface, #fff);
}
.vis-opt.on .vis-radio {
  border-color: var(--color-primary, #b5532a);
  box-shadow: inset 0 0 0 3px var(--color-primary, #b5532a);
}
.vis-text { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.vis-label { font-weight: 600; font-size: 0.92rem; }
.vis-hint { font-size: 0.8rem; color: var(--color-mute, #6b6b6b); line-height: 1.4; }

.sp-confirm {
  margin-top: 0.75rem;
  padding: 0.8rem 0.9rem;
  border: 1px solid #e8b9a8;
  background: #fdf2ee;
  border-radius: 8px;
}
.sp-confirm-text { margin: 0 0 0.7rem; font-size: 0.85rem; line-height: 1.5; color: #7a2a10; }
.sp-confirm-actions { display: flex; gap: 0.4rem; }

/* ── Invitation ── */
.invite-form { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.inp, .sel {
  font: inherit;
  font-size: 0.88rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 6px;
  background: var(--color-bg, #faf9f7);
  color: var(--color-ink, #1a1a1a);
}
.inp:focus, .sel:focus {
  outline: none;
  border-color: var(--color-primary, #b5532a);
}
.invite-form .inp { flex: 1 1 12rem; min-width: 0; }

/* ── Qui a accès ── */
.grant-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.grant-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--color-hair, #e5e2dc);
  border-radius: 6px;
  background: var(--color-bg, #faf9f7);
}
.grant-who { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 0.4rem; }
.grant-email {
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grant-pending {
  flex: 0 0 auto;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0.08rem 0.35rem;
  border-radius: 999px;
  background: #fdf2ee;
  color: #8a2d10;
  border: 1px solid #e8b9a8;
}
.grant-mode { flex: 0 0 auto; font-size: 0.8rem; padding: 0.3rem 0.4rem; }
.grant-revoke { flex: 0 0 auto; font-size: 0.78rem; padding: 0.3rem 0.55rem; color: var(--color-mute, #6b6b6b); }
.grant-revoke:hover:not(:disabled) { color: #8a2d10; border-color: #e8b9a8; }

/* ── Lien ── */
.link-row { display: flex; gap: 0.4rem; }
.link-field {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--font-mono, monospace);
  font-size: 0.78rem;
}

/* ── Boutons (alignés sur les vues v3) ── */
.btn {
  font: inherit;
  font-size: 0.85rem;
  padding: 0.45rem 0.85rem;
  border-radius: 6px;
  border: 1px solid var(--color-hair, #e5e2dc);
  background: var(--color-surface, #fff);
  color: var(--color-ink, #1a1a1a);
  cursor: pointer;
  white-space: nowrap;
}
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary {
  background: var(--color-primary, #b5532a);
  border-color: var(--color-primary, #b5532a);
  color: #fff;
}
.btn.ghost { background: transparent; }

/* ── États ── */
.sp-flash {
  background: var(--color-bg, #faf9f7);
  border: 1px solid var(--color-hair, #e5e2dc);
  border-left: 3px solid var(--color-primary, #b5532a);
  padding: 0.5rem 0.7rem;
  border-radius: 6px;
  font-size: 0.85rem;
  margin: 0 0 1rem;
}
.sp-err {
  margin: 0.6rem 0 0;
  background: #fdf2ee;
  border: 1px solid #e8b9a8;
  color: #8a2d10;
  padding: 0.5rem 0.7rem;
  border-radius: 6px;
  font-size: 0.82rem;
}
.sp-state { margin: 0.5rem 0 0; }
.muted { color: var(--color-mute, #6b6b6b); }
.small { font-size: 0.8rem; }
</style>
