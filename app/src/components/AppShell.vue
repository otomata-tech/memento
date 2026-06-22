<script setup lang="ts">
// Common page chrome: top bar (brand, Read/Graph/Loop nav, ⌘K search,
// knowledge base selector FOR THE CURRENT ORG, favorite, org menu, account menu) + crumbs + body.
// The org is a context (sharing scope) switched near the account — Notion-style;
// the knowledge base selector only shows the current org's bases.
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, type AdminOrg } from "../api";
import { supabase } from "../auth";
import SharePanel from "./SharePanel.vue";
import { shell, initSession, loadShell, loadInbox, loadPending } from "../stores/shell";

const props = defineProps<{ page: "reader" | "graph" | "loop" | "org" | "comptes" | "inbox" | "home"; ws: string; org?: string }>();
const router = useRouter();

// Shared chrome state = single source of truth in the store, read here as computeds
// (template unchanged; only the data origin moves). Mutations go through the store
// actions so every surface stays in sync — no more stale menu/badges after navigation.
const orgList = computed(() => shell.orgs);
const shared = computed(() => shell.shared);
const pins = computed(() => shell.pins);
const platformAdmin = computed(() => shell.platformAdmin);
const favorite = computed(() => shell.favorite);
const pending = computed(() => shell.pending);
const inboxCount = computed(() => shell.inboxCount);
const email = computed(() => shell.email);
const authed = computed(() => shell.authed);
// Purely-local UI state.
const q = ref("");
const menuOpen = ref(false);
const orgOpen = ref(false);
const shareOpen = ref(false); // Share popover (org-admin of the current base)
const newOrgName = ref("");
const newOrgOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);

/** Current org: explicit (/org/:org pages), otherwise the owning org of the open base. */
const currentOrg = computed<AdminOrg | null>(() => {
  if (props.org) return orgList.value.find((o) => o.slug === props.org) ?? null;
  return orgList.value.find((o) => o.workspaces.some((w) => w.slug === props.ws)) ?? null;
});
/** Current org's bases (the selector does not cross orgs). */
const wsList = computed(() => currentOrg.value?.workspaces ?? []);

// loadShell / loadPending / loadInbox now live in the store (../stores/shell).

function go(path: string) { router.push(path); }
/** Logo → app home: the user's whole universe. */
function goHome() { router.push("/home"); }
function switchWs(e: Event) { router.push(`/w/${(e.target as HTMLSelectElement).value}`); }
/** Org switch: lands on its default base if inside, otherwise the first, otherwise its page. */
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
  shell.favorite = r.defaultWorkspace;
}
/** Current KB outside my orgs (granted or public) → candidate for pinning. */
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

/** Share = tenant governance: visible if admin of the current base's org. */
const canShare = computed(() => !!props.ws && currentOrg.value?.myRole === "admin");
function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchInput.value?.focus(); searchInput.value?.select(); }
  else if (e.key === "Escape" && document.activeElement === searchInput.value) searchInput.value?.blur();
}

onMounted(async () => {
  await initSession();
  loadShell(); loadPending(props.ws); loadInbox();
  document.addEventListener("click", onDocClick);
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => { document.removeEventListener("click", onDocClick); window.removeEventListener("keydown", onKey); });
// Vue Router reuses the same view instance across routes that resolve to the same
// component (e.g. /w/:ws/doc vs /w/:ws/section), so onMounted runs once. Re-sync the
// chrome whenever the KB/org CONTEXT changes — not on every doc/block click — so the
// menu, KB selector and badges never go stale after navigation.
watch(() => [props.ws, props.org], () => { loadShell(); loadPending(props.ws); loadInbox(); });
defineExpose({ reloadShell: loadShell });
</script>

<template>
  <div class="ed">
    <div class="top">
      <div class="brand" @click="goHome" title="Accueil">
        <svg class="brand-mark" viewBox="-64 -64 128 128" aria-hidden="true">
          <defs>
            <radialGradient id="mlogo" cx="38%" cy="32%" r="78%">
              <stop offset="0%" stop-color="#4f9be0" />
              <stop offset="55%" stop-color="#1f6dba" />
              <stop offset="100%" stop-color="#124a80" />
            </radialGradient>
          </defs>
          <path d="M-44 14 Q -22 -34, 0 2 T 44 -10" fill="none" stroke="url(#mlogo)" stroke-width="12" stroke-linecap="round" />
        </svg>
        <span class="brand-word">Memento</span>
        <small>{{ ws || currentOrg?.slug || "" }}</small>
      </div>
      <div class="nav" v-if="ws">
        <a :class="{ on: page === 'reader' }" @click="go(`/w/${ws}`)">Read</a>
        <a :class="{ on: page === 'graph' }" @click="go(`/w/${ws}/graph`)">Graph</a>
        <a v-if="authed" :class="{ on: page === 'loop' }" @click="go(`/w/${ws}/loop`)">
          Loop <span v-if="pending" class="pin">{{ pending }}</span>
        </a>
      </div>
      <form class="srch" v-if="ws" @submit.prevent="runSearch">
        <input ref="searchInput" v-model="q" placeholder="type · section · trust…" />
        <button type="submit" class="k">⌘K</button>
      </form>
      <div class="topright">
        <a v-if="authed" class="inbox-nav" :class="{ on: page === 'inbox' }" @click="go('/inbox')"
          title="Pending changes across all your knowledge bases">
          📥 Inbox <span v-if="inboxCount" class="pin">{{ inboxCount }}</span>
        </a>
        <select v-if="ws && wsList.length > 1" class="ws-switch" :value="ws" @change="switchWs" title="Switch knowledge base (current org)">
          <option v-for="w in wsList" :key="w.slug" :value="w.slug">{{ w.name }}</option>
        </select>
        <button v-if="ws && authed" class="fav" :class="{ on: favorite === ws }" @click="toggleFav"
          :title="favorite === ws ? 'Default knowledge base' : 'Set as default knowledge base'">
          {{ favorite === ws ? "★" : "☆" }}
        </button>
        <button v-if="ws && authed && isForeign" class="pin" :class="{ on: isPinned }" @click="togglePin"
          :title="isPinned ? 'Unpin from my universe' : 'Pin to my universe'">📌</button>

        <div v-if="canShare" class="sharew">
          <button class="share-btn" :class="{ on: shareOpen }" @click="shareOpen = !shareOpen">Share</button>
          <div v-if="shareOpen" class="acct-menu share-menu" @click.stop>
            <SharePanel :key="ws" :workspace="ws" @changed="loadShell" />
          </div>
        </div>

        <a v-if="!authed" class="signin" href="/login" title="Sign in">Sign in</a>

        <div v-if="authed" class="orgsw">
          <button class="orgsw-btn" :class="{ on: orgOpen }" @click="orgOpen = !orgOpen" title="Organization">
            {{ currentOrg?.name ?? "Organization" }} <span class="cv">⌄</span>
          </button>
          <div v-if="orgOpen" class="acct-menu orgsw-menu">
            <div class="acct-id"><div class="eb">Organizations</div></div>
            <button v-for="o in orgList" :key="o.id" class="acct-item org-row"
              :class="{ cur: o.slug === currentOrg?.slug }" @click="switchOrg(o)">
              <span class="dot">{{ o.slug === currentOrg?.slug ? "●" : "○" }}</span> {{ o.name }}
              <span class="role">{{ o.myRole }}</span>
            </button>
            <template v-if="shared.length">
              <div class="acct-id"><div class="eb">Shared with me</div></div>
              <button v-for="w in shared" :key="w.slug" class="acct-item org-row"
                :class="{ cur: w.slug === ws }" @click="orgOpen = false; go(`/w/${w.slug}`)">
                <span class="dot">{{ w.slug === ws ? "●" : "○" }}</span> {{ w.name }}
              </button>
            </template>
            <template v-if="pins.length">
              <div class="acct-id"><div class="eb">Pinned public</div></div>
              <button v-for="w in pins" :key="w.slug" class="acct-item org-row"
                :class="{ cur: w.slug === ws }" @click="orgOpen = false; go(`/w/${w.slug}`)">
                <span class="dot">{{ w.slug === ws ? "●" : "📌" }}</span> {{ w.name }}
              </button>
            </template>
            <router-link v-if="currentOrg" class="acct-item" :to="`/org/${currentOrg.slug}/bases`" @click="orgOpen = false">
              ⚙︎ Manage {{ currentOrg.name }}
            </router-link>
            <router-link v-if="platformAdmin" class="acct-item" to="/comptes" @click="orgOpen = false">
              ⌂ Accounts (platform)
            </router-link>
            <button v-if="!newOrgOpen" class="acct-item" @click.stop="newOrgOpen = true">＋ New organization</button>
            <form v-else class="neworg-inline" @submit.prevent="createOrg" @click.stop>
              <input v-model="newOrgName" placeholder="Name (mission, client…)" required />
              <button type="submit">Create</button>
            </form>
          </div>
        </div>

        <div v-if="authed" class="acct">
          <button class="acct-btn" :class="{ on: menuOpen }" @click="menuOpen = !menuOpen" title="My account">
            <span class="ava">{{ (email || "?").slice(0, 1).toUpperCase() }}</span>
            <span class="cv">⌄</span>
          </button>
          <div v-if="menuOpen" class="acct-menu">
            <div class="acct-id">
              <div class="eb">Account</div>
              <div class="acct-mail">{{ email || "—" }}</div>
            </div>
            <router-link class="acct-item" to="/plugin" @click="menuOpen = false">⚡ Connect an MCP client</router-link>
            <button class="acct-item danger" @click="logout">⏏ Sign out</button>
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
.inbox-nav { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--color-hair); background: none; color: var(--color-ink-soft); padding: 5px 10px; font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; white-space: nowrap; }
.inbox-nav.on, .inbox-nav:hover { border-color: var(--color-ink); color: var(--color-ink); }
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
