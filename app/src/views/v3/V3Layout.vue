<script setup lang="ts">
/**
 * Memento V3 — shell du viewer page-centré. Barre : marque + sélecteur de KB (base) +
 * nav (Pages / Recherche / Boîte de réception). Les vues s'affichent dans <router-view>.
 * Charge les bases au montage ; le choix est partagé via `../../v3/base`.
 */
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { bases, currentBase, basesLoaded, loadBases, setBase } from "../../v3/base";
import { supabase } from "../../auth";

const router = useRouter();

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
      <button class="signout" @click="signOut">Déconnexion</button>
    </header>
    <main class="content">
      <router-view v-if="basesLoaded && currentBase" :key="currentBase" />
      <p v-else-if="basesLoaded" class="empty">Aucune base de connaissances accessible avec ce compte.</p>
      <p v-else class="empty">Chargement…</p>
    </main>
  </div>
</template>

<style scoped>
.v3 { min-height: 100vh; background: var(--color-bg, #faf9f7); color: var(--color-ink, #1a1a1a); }
.bar {
  display: flex; align-items: center; gap: 16px; padding: 12px 22px;
  border-bottom: 1px solid var(--color-hair, #e5e2dc); background: var(--color-surface, #fff); position: sticky; top: 0; z-index: 10;
}
.brand { font-family: var(--font-display, serif); font-weight: 700; font-size: 17px; color: var(--color-primary-ink, #1a1a1a); }
.base-select { padding: 6px 10px; border: 1px solid var(--color-hair, #e5e2dc); background: var(--color-bg, #faf9f7); font: inherit; max-width: 280px; }
.nav { display: flex; gap: 4px; margin-left: 8px; }
.nav a { padding: 6px 12px; color: var(--color-mute, #6b6b6b); text-decoration: none; font-size: 14px; border-radius: 4px; }
.nav a:hover { background: var(--color-bg, #f3f1ec); }
.nav a.on { color: var(--color-ink, #1a1a1a); font-weight: 600; background: var(--color-bg, #f3f1ec); }
.signout { margin-left: auto; border: 1px solid var(--color-hair, #e5e2dc); background: none; color: var(--color-mute, #6b6b6b); padding: 6px 12px; font-size: 13px; cursor: pointer; }
.content { padding: 24px 22px; max-width: 1100px; margin: 0 auto; }
.empty { color: var(--color-mute, #6b6b6b); padding: 40px 0; text-align: center; }
</style>
