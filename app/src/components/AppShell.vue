<script setup lang="ts">
// Chrome commun des pages : top bar (brand, nav Lire/Graphe/Boucle, recherche ⌘K,
// sélecteur de bases DE L'ORG COURANTE, favori, menu org, menu compte) + crumbs + corps.
// L'org est un contexte (périmètre de partage) switché près du compte — façon Notion ;
// le sélecteur de bases ne montre que les bases de l'org courante.
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, type AdminOrg } from "../api";
import { supabase } from "../auth";
import SharePanel from "./SharePanel.vue";

const props = defineProps<{ page: "reader" | "graph" | "loop" | "org" | "comptes"; ws: string; org?: string }>();
const router = useRouter();

const orgList = ref<AdminOrg[]>([]);
const shared = ref<{ slug: string; name: string }[]>([]); // KB grantées hors de mes orgs
const pins = ref<{ slug: string; name: string }[]>([]); // KB publiques épinglées (mon univers)
const platformAdmin = ref(false); // opérateur plateforme → entrée « Comptes » du menu org
const favorite = ref<string | null>(null);
const pending = ref(0);
const q = ref("");
const email = ref<string | null>(null);
const menuOpen = ref(false);
const orgOpen = ref(false);
const shareOpen = ref(false); // popover Partager (org-admin de la base courante)
const newOrgName = ref("");
const newOrgOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);
const authed = ref(false); // false = lecture anonyme (KB publique) : pas de menus compte/org

/** Org courante : explicite (pages /org/:org), sinon l'org propriétaire de la base ouverte. */
const currentOrg = computed<AdminOrg | null>(() => {
  if (props.org) return orgList.value.find((o) => o.slug === props.org) ?? null;
  return orgList.value.find((o) => o.workspaces.some((w) => w.slug === props.ws)) ?? null;
});
/** Bases de l'org courante (le sélecteur ne traverse pas les orgs). */
const wsList = computed(() => currentOrg.value?.workspaces ?? []);

async function loadShell() {
  if (!authed.value) return; // anonyme : aucune surface compte/org à charger
  try {
    const [r, prefs, all, pinned] = await Promise.all([api.admin.orgs(), api.prefs(), api.workspaces(), api.pinned()]);
    orgList.value = r.orgs;
    favorite.value = prefs.defaultWorkspace;
    // « Partagées avec moi » : accessibles (grant) mais dans aucune de mes orgs.
    const inOrgs = new Set(r.orgs.flatMap((o) => o.workspaces.map((w) => w.slug)));
    shared.value = all.filter((w) => !inOrgs.has(w.slug));
    // « Publiques épinglées » : mes pins qui ne sont ni dans mes orgs ni en partagées.
    const known = new Set([...inOrgs, ...shared.value.map((w) => w.slug)]);
    pins.value = pinned.filter((w) => !known.has(w.slug)).map((w) => ({ slug: w.slug, name: w.name }));
  } catch { /* la garde de session gère le 401 */ }
  // Probe plateforme (403 = pas opérateur, silencieux) — pilote l'entrée « Comptes ».
  try { await api.admin.accounts(); platformAdmin.value = true; } catch { platformAdmin.value = false; }
}
async function loadPending() {
  if (!props.ws || !authed.value) { pending.value = 0; return; }
  try {
    const r = await api.ingestions(props.ws, "PROPOSED");
    pending.value = r.count;
  } catch { pending.value = 0; }
}

function go(path: string) { router.push(path); }
function switchWs(e: Event) { router.push(`/w/${(e.target as HTMLSelectElement).value}`); }
/** Switch d'org : atterrit sur sa base par défaut si dedans, sinon la première, sinon sa page. */
function switchOrg(o: AdminOrg) {
  orgOpen.value = false;
  const target = [favorite.value, o.workspaces[0]?.slug]
    .find((s) => s && o.workspaces.some((w) => w.slug === s));
  router.push(target ? `/w/${target}` : `/org/${o.slug}/bases`);
}
async function createOrg() {
  if (!newOrgName.value.trim()) return;
  const o = await api.admin.createOrg(newOrgName.value.trim());
  newOrgName.value = ""; newOrgOpen.value = false; orgOpen.value = false;
  await loadShell();
  router.push(`/org/${o.slug}/bases`);
}
async function toggleFav() {
  const r = await api.setDefaultWorkspace(props.ws);
  favorite.value = r.defaultWorkspace;
}
/** KB courante hors de mes orgs (granted ou publique) → candidate à l'épinglage. */
const isForeign = computed(() => !!props.ws && !orgList.value.some((o) => o.workspaces.some((w) => w.slug === props.ws)));
const isPinned = computed(() => pins.value.some((p) => p.slug === props.ws));
async function togglePin() {
  if (isPinned.value) await api.unpinWorkspace(props.ws);
  else await api.pinWorkspace(props.ws);
  await loadShell();
}
function runSearch() {
  if (q.value.trim()) router.push({ path: `/w/${props.ws}/search`, query: { q: q.value.trim() } });
}
async function logout() {
  menuOpen.value = false;
  await supabase.auth.signOut();
  router.replace("/login");
}
function onDocClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (menuOpen.value && !t.closest(".acct")) menuOpen.value = false;
  if (orgOpen.value && !t.closest(".orgsw")) { orgOpen.value = false; newOrgOpen.value = false; }
  if (shareOpen.value && !t.closest(".sharew")) shareOpen.value = false;
}

/** Partager = gouvernance du tenant : visible si admin de l'org de la base courante. */
const canShare = computed(() => !!props.ws && currentOrg.value?.myRole === "admin");
function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchInput.value?.focus(); searchInput.value?.select(); }
  else if (e.key === "Escape" && document.activeElement === searchInput.value) searchInput.value?.blur();
}

onMounted(async () => {
  authed.value = !!(await supabase.auth.getSession()).data.session;
  loadShell(); loadPending();
  email.value = (await supabase.auth.getUser()).data.user?.email ?? null;
  document.addEventListener("click", onDocClick);
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => { document.removeEventListener("click", onDocClick); window.removeEventListener("keydown", onKey); });
watch(() => props.ws, () => loadPending());
defineExpose({ reloadShell: loadShell });
</script>

<template>
  <div class="ed">
    <div class="top">
      <div class="brand">Memento<small>{{ ws || currentOrg?.slug || "" }}</small></div>
      <div class="nav" v-if="ws">
        <a :class="{ on: page === 'reader' }" @click="go(`/w/${ws}`)">Lire</a>
        <a :class="{ on: page === 'graph' }" @click="go(`/w/${ws}/graph`)">Graphe</a>
        <a v-if="authed" :class="{ on: page === 'loop' }" @click="go(`/w/${ws}/loop`)">
          Boucle <span v-if="pending" class="pin">{{ pending }}</span>
        </a>
      </div>
      <form class="srch" v-if="ws" @submit.prevent="runSearch">
        <input ref="searchInput" v-model="q" placeholder="type · section · confiance…" />
        <button type="submit" class="k">⌘K</button>
      </form>
      <div class="topright">
        <select v-if="ws && wsList.length > 1" class="ws-switch" :value="ws" @change="switchWs" title="Changer de base (org courante)">
          <option v-for="w in wsList" :key="w.slug" :value="w.slug">{{ w.name }}</option>
        </select>
        <button v-if="ws && authed" class="fav" :class="{ on: favorite === ws }" @click="toggleFav"
          :title="favorite === ws ? 'Base par défaut' : 'Définir comme base par défaut'">
          {{ favorite === ws ? "★" : "☆" }}
        </button>
        <button v-if="ws && authed && isForeign" class="pin" :class="{ on: isPinned }" @click="togglePin"
          :title="isPinned ? 'Désépingler de mon univers' : 'Épingler dans mon univers'">📌</button>

        <div v-if="canShare" class="sharew">
          <button class="share-btn" :class="{ on: shareOpen }" @click="shareOpen = !shareOpen">Partager</button>
          <div v-if="shareOpen" class="acct-menu share-menu" @click.stop>
            <SharePanel :key="ws" :workspace="ws" @changed="loadShell" />
          </div>
        </div>

        <a v-if="!authed" class="signin" href="/login" title="Se connecter">Se connecter</a>

        <div v-if="authed" class="orgsw">
          <button class="orgsw-btn" :class="{ on: orgOpen }" @click="orgOpen = !orgOpen" title="Organisation">
            {{ currentOrg?.name ?? "Organisation" }} <span class="cv">⌄</span>
          </button>
          <div v-if="orgOpen" class="acct-menu orgsw-menu">
            <div class="acct-id"><div class="eb">Organisations</div></div>
            <button v-for="o in orgList" :key="o.id" class="acct-item org-row"
              :class="{ cur: o.slug === currentOrg?.slug }" @click="switchOrg(o)">
              <span class="dot">{{ o.slug === currentOrg?.slug ? "●" : "○" }}</span> {{ o.name }}
              <span class="role">{{ o.myRole }}</span>
            </button>
            <template v-if="shared.length">
              <div class="acct-id"><div class="eb">Partagées avec moi</div></div>
              <button v-for="w in shared" :key="w.slug" class="acct-item org-row"
                :class="{ cur: w.slug === ws }" @click="orgOpen = false; go(`/w/${w.slug}`)">
                <span class="dot">{{ w.slug === ws ? "●" : "○" }}</span> {{ w.name }}
              </button>
            </template>
            <template v-if="pins.length">
              <div class="acct-id"><div class="eb">Publiques épinglées</div></div>
              <button v-for="w in pins" :key="w.slug" class="acct-item org-row"
                :class="{ cur: w.slug === ws }" @click="orgOpen = false; go(`/w/${w.slug}`)">
                <span class="dot">{{ w.slug === ws ? "●" : "📌" }}</span> {{ w.name }}
              </button>
            </template>
            <router-link v-if="currentOrg" class="acct-item" :to="`/org/${currentOrg.slug}/bases`" @click="orgOpen = false">
              ⚙︎ Gérer {{ currentOrg.name }}
            </router-link>
            <router-link v-if="platformAdmin" class="acct-item" to="/comptes" @click="orgOpen = false">
              ⌂ Comptes (plateforme)
            </router-link>
            <button v-if="!newOrgOpen" class="acct-item" @click.stop="newOrgOpen = true">＋ Nouvelle organisation</button>
            <form v-else class="neworg-inline" @submit.prevent="createOrg" @click.stop>
              <input v-model="newOrgName" placeholder="Nom (mission, client…)" required />
              <button type="submit">Créer</button>
            </form>
          </div>
        </div>

        <div v-if="authed" class="acct">
          <button class="acct-btn" :class="{ on: menuOpen }" @click="menuOpen = !menuOpen" title="Mon compte">
            <span class="ava">{{ (email || "?").slice(0, 1).toUpperCase() }}</span>
            <span class="cv">⌄</span>
          </button>
          <div v-if="menuOpen" class="acct-menu">
            <div class="acct-id">
              <div class="eb">Compte</div>
              <div class="acct-mail">{{ email || "—" }}</div>
            </div>
            <router-link class="acct-item" to="/plugin" @click="menuOpen = false">⚡ Connecter un client MCP</router-link>
            <button class="acct-item danger" @click="logout">⏏ Se déconnecter</button>
          </div>
        </div>
      </div>
    </div>

    <div class="crumbs">
      <a v-if="ws" @click="go(`/w/${ws}`)">{{ ws }}</a>
      <a v-else-if="currentOrg" @click="go(`/org/${currentOrg.slug}/bases`)">{{ currentOrg.slug }}</a>
      <span>/</span>
      <slot name="crumbs" />
    </div>

    <slot />
  </div>
</template>

<style scoped>
.sharew { position: relative; }
.share-btn {
  border: 1px solid var(--color-hair); background: none; color: var(--color-ink-soft);
  padding: 5px 10px; font: inherit; font-size: 13px; cursor: pointer;
}
.share-btn.on, .share-btn:hover { border-color: var(--color-ink); color: var(--color-ink); }
.share-menu { padding: 14px; }
.signin {
  border: 1px solid var(--color-ink); background: var(--color-ink); color: var(--color-bg);
  padding: 5px 12px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none;
}
.orgsw { position: relative; }
.orgsw-btn {
  border: 1px solid var(--color-hair); background: none; color: var(--color-ink-soft);
  padding: 5px 10px; font: inherit; font-size: 13px; cursor: pointer;
  max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.orgsw-btn.on, .orgsw-btn:hover { border-color: var(--color-ink); color: var(--color-ink); }
.orgsw-menu { min-width: 240px; }
.org-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; }
.org-row .dot { font-size: 9px; color: var(--color-primary-ink); }
.org-row .role { margin-left: auto; font-family: var(--font-mono); font-size: 10px; color: var(--color-faint); text-transform: uppercase; }
.org-row.cur { font-weight: 600; }
.neworg-inline { display: flex; gap: 6px; padding: 8px 12px; }
.neworg-inline input { flex: 1; border: 1px solid var(--color-hair); background: var(--color-bg); padding: 6px 8px; font: inherit; font-size: 13px; }
.neworg-inline button { border: 1px solid var(--color-ink); background: var(--color-ink); color: var(--color-bg); padding: 6px 10px; font-weight: 600; cursor: pointer; }
</style>
