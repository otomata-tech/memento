<script setup lang="ts">
/**
 * Memento V3 — shell du viewer page-centré. Barre : marque + sélecteur de KB (base) +
 * nav (Pages / Recherche / Boîte de réception). Les vues s'affichent dans <router-view>.
 * Charge les bases au montage ; le choix est partagé via `../../v3/base`.
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { bases, currentBase, basesLoaded, loadBases, setBase } from "../../v3/base";
import { supabase } from "../../auth";
import CommandPalette from "./CommandPalette.vue";

const router = useRouter();
const route = useRoute();
// La vue Pages (arbre + colonnes Miller) est un explorateur → pleine largeur/hauteur.
// Les vues document (Recherche/Org/Connecteur/Inbox) gardent un cadre centré lisible.
const isPagesView = computed(() => route.path === "/v3" || route.path.startsWith("/v3/page"));
const palette = ref<InstanceType<typeof CommandPalette> | null>(null);

onMounted(async () => {
  try { await loadBases(); }
  catch (e) { console.error("loadBases", e); }
});

function onBaseChange(e: Event) {
  setBase((e.target as HTMLSelectElement).value);
  // Revenir à l'arbre de la nouvelle base (les vues détail référencent l'ancienne).
  if (router.currentRoute.value.path !== "/v3") router.push("/v3");
}

async function signOut() {
  await supabase.auth.signOut();
  window.location.href = "/login";
}
</script>

<template>
  <div class="v3">
    <header class="bar">
      <div class="brand">Memento</div>
      <select class="base-select" :value="currentBase" @change="onBaseChange" :disabled="!basesLoaded">
        <option v-if="!basesLoaded" value="">Chargement…</option>
        <option v-for="b in bases" :key="b.id" :value="b.id">{{ b.name }}</option>
        <option v-if="basesLoaded && !bases.length" value="">Aucune base accessible</option>
      </select>
      <nav class="nav">
        <router-link to="/v3" exact-active-class="on">Pages</router-link>
        <router-link to="/v3/search" active-class="on">Recherche</router-link>
        <router-link to="/v3/inbox" active-class="on">Boîte de réception</router-link>
        <router-link to="/v3/org" active-class="on">Organisation</router-link>
        <router-link to="/v3/connector" active-class="on">Connecteur</router-link>
      </nav>
      <button
        class="cmdk-hint"
        title="Palette de commandes (Ctrl/⌘ + K)"
        aria-label="Ouvrir la palette de commandes"
        @click="palette?.open()"
      >
        <span class="cmdk-k">⌘K</span>
      </button>
      <button class="signout" @click="signOut">Déconnexion</button>
    </header>
    <main class="content" :class="{ flush: isPagesView }">
      <router-view v-if="basesLoaded && currentBase" :key="currentBase" />
      <p v-else-if="basesLoaded" class="empty">Aucune base de connaissances accessible avec ce compte.</p>
      <p v-else class="empty">Chargement…</p>
    </main>
    <CommandPalette ref="palette" />
  </div>
</template>

<style scoped>
.v3 { display: flex; flex-direction: column; height: 100vh; background: var(--color-bg, #faf9f7); color: var(--color-ink, #1a1a1a); }
.bar {
  flex: none;
  display: flex; align-items: center; gap: 16px; padding: 12px 22px;
  border-bottom: 1px solid var(--color-hair, #e5e2dc); background: var(--color-surface, #fff); z-index: 10;
}
.brand { font-family: var(--font-display, serif); font-weight: 700; font-size: 17px; color: var(--color-primary-ink, #1a1a1a); flex: none; }
.base-select { padding: 6px 10px; border: 1px solid var(--color-hair, #e5e2dc); background: var(--color-bg, #faf9f7); font: inherit; max-width: 280px; min-width: 0; }
.nav { display: flex; gap: 4px; margin-left: 8px; }
.nav a { padding: 6px 12px; color: var(--color-mute, #6b6b6b); text-decoration: none; font-size: 14px; border-radius: 4px; }
.nav a:hover { background: var(--color-bg, #f3f1ec); }
.nav a.on { color: var(--color-ink, #1a1a1a); font-weight: 600; background: var(--color-bg, #f3f1ec); }
.cmdk-hint { margin-left: auto; border: 1px solid var(--color-hair, #e5e2dc); background: var(--color-bg, #faf9f7); color: var(--color-mute, #6b6b6b); padding: 5px 9px; border-radius: 6px; font-size: 12px; cursor: pointer; }
.cmdk-hint:hover { border-color: var(--color-primary, #b5532a); color: var(--color-primary, #b5532a); }
.cmdk-k { font-family: var(--font-mono, monospace); letter-spacing: 0.02em; }
.signout { border: 1px solid var(--color-hair, #e5e2dc); background: none; color: var(--color-mute, #6b6b6b); padding: 6px 12px; font-size: 13px; cursor: pointer; }
/* Vues document : cadre centré lisible, la zone scrolle. */
.content { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 24px 22px; max-width: min(1100px, 92vw); margin: 0 auto; width: 100%; box-sizing: border-box; }
/* Vue Pages : app-shell pleine largeur/hauteur, scroll géré en interne (colonnes). */
.content.flush { max-width: none; margin: 0; padding: 0; overflow: hidden; }
.empty { color: var(--color-mute, #6b6b6b); padding: 40px 0; text-align: center; }

/* ── Responsive : sous 820px, le header s'empile (marque+base+déco sur une ligne,
   nav défilable sur la suivante) ; ⌘K masqué (pas de clavier). ── */
@media (max-width: 820px) {
  .bar { flex-wrap: wrap; gap: 8px 12px; padding: 10px 14px; }
  .base-select { flex: 1 1 120px; max-width: none; }
  .cmdk-hint { display: none; }
  .nav {
    order: 5; width: 100%; margin-left: 0; gap: 2px;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .nav::-webkit-scrollbar { display: none; }
  .nav a { white-space: nowrap; padding: 6px 10px; }
  .content:not(.flush) { padding: 16px 14px; max-width: 100%; }
}
</style>
