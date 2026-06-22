<script setup lang="ts">
// Global home (me.mento.cc /home): the user's whole universe — every org with its
// bases, plus KBs shared with them and pinned public ones. Reads the shell store
// (AppShell loads it on mount); no fetch of its own.
import { computed } from "vue";
import { useRouter } from "vue-router";
import AppShell from "../components/AppShell.vue";
import { shell } from "../stores/shell";

const router = useRouter();
const orgs = computed(() => shell.orgs);
const shared = computed(() => shell.shared);
const pins = computed(() => shell.pins);
const empty = computed(() => !orgs.value.length && !shared.value.length && !pins.value.length);

function bases(o: (typeof shell.orgs)[number]) { return o.workspaces.filter((w) => !w.archived); }
function open(slug: string) { router.push(`/w/${slug}`); }
function manage(slug: string) { router.push(`/org/${slug}/bases`); }
</script>

<template>
  <AppShell page="home" ws="">
    <template #crumbs><span><b>My universe</b></span></template>

    <div class="content">
      <h1>My universe</h1>

      <p v-if="empty" class="muted">No knowledge base yet. Create one from an organization’s page.</p>

      <!-- Orgs and their bases -->
      <section v-for="o in orgs" :key="o.id" class="org">
        <header class="org-head">
          <button class="org-name" @click="manage(o.slug)" :title="`Manage ${o.name}`">
            {{ o.name }}<span class="slug">{{ o.slug }}</span>
          </button>
          <span v-if="o.myRole" class="badge" :class="o.myRole">{{ o.myRole }}</span>
        </header>
        <div class="grid">
          <button v-for="w in bases(o)" :key="w.slug" class="base" @click="open(w.slug)">
            <span class="base-name">{{ w.name }}</span>
            <span v-if="w.visibility === 'private'" class="vis" title="Access by invitation only">🔒</span>
            <span v-else-if="w.visibility === 'public'" class="vis" title="Readable by everyone">🌐</span>
          </button>
          <button class="base add" @click="manage(o.slug)" title="Manage bases / create one">＋</button>
        </div>
      </section>

      <!-- Shared with me -->
      <section v-if="shared.length" class="org">
        <header class="org-head"><span class="eb">Shared with me</span></header>
        <div class="grid">
          <button v-for="w in shared" :key="w.slug" class="base" @click="open(w.slug)">
            <span class="base-name">{{ w.name }}</span>
          </button>
        </div>
      </section>

      <!-- Pinned public -->
      <section v-if="pins.length" class="org">
        <header class="org-head"><span class="eb">Pinned public</span></header>
        <div class="grid">
          <button v-for="w in pins" :key="w.slug" class="base" @click="open(w.slug)">
            <span class="base-name">{{ w.name }}</span><span class="vis">📌</span>
          </button>
        </div>
      </section>
    </div>
  </AppShell>
</template>

<style scoped>
/* Editorial: no radius. Lives in AppShell (.ed). */
.content { padding: 24px; max-width: 860px; width: 100%; margin: 0 auto; }
.content h1 { font-family: var(--font-display); font-size: 22px; margin: 0 0 20px; }
.org { margin-bottom: 26px; }
.org-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.org-name { border: none; background: none; padding: 0; font: inherit; font-family: var(--font-display); font-weight: 700; font-size: 15px; color: var(--color-ink); cursor: pointer; }
.org-name:hover { color: var(--color-primary-ink); }
.slug { font-family: var(--font-mono); font-size: 11px; color: var(--color-faint); margin-left: 8px; font-weight: 400; }
.eb { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-mute); font-weight: 600; }
.badge { font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; padding: 2px 7px; background: var(--color-paper-2); color: var(--color-ink-soft); }
.badge.admin { background: var(--color-primary-soft); color: var(--color-primary-ink); }
.badge.curator { background: var(--color-strong-bg); color: var(--color-strong-ink); }
.grid { display: flex; flex-wrap: wrap; gap: 10px; }
.base { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--color-hair); background: var(--color-surface); padding: 12px 16px; min-width: 150px; font: inherit; cursor: pointer; text-align: left; }
.base:hover { border-color: var(--color-ink); }
.base-name { font-weight: 600; font-size: 14px; color: var(--color-ink); }
.vis { font-size: 12px; }
.base.add { color: var(--color-mute); font-size: 18px; min-width: 0; justify-content: center; padding: 12px 18px; }
.base.add:hover { color: var(--color-primary-ink); border-color: var(--color-primary); }
.muted { color: var(--color-mute); }
</style>
