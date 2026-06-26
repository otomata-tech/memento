<script setup lang="ts">
/**
 * Memento V3 — vue Org/équipe (issue #71). Gère l'org qui détient la base active :
 * membres (rôle admin|member, pending), invitations (par email), renommage de la base
 * (1 org = 1 base), création d'une nouvelle org. Tout passe par le verbe `admin`.
 * Pas de dialog natif (confirm/prompt) — confirmations inline.
 */
import { computed, onMounted, ref, watch } from "vue";
import { apiV3, type AdminOrg, type OrgRole, type InviteResult } from "../../api.v3";
import { currentBase, currentBaseRef, loadBases } from "../../v3/base";

const orgs = ref<AdminOrg[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const flash = ref<string | null>(null);
const invite = ref<{ email: string; link: string } | null>(null);

const inviteForm = ref<{ email: string; role: OrgRole }>({ email: "", role: "member" });
const newOrg = ref("");
const renaming = ref(false);
const renameTo = ref("");
const confirmRemove = ref<string | null>(null); // userId dont la suppression est à confirmer
const busy = ref(false);

// Org propriétaire de la base active (1 base/org) — c'est celle qu'on administre ici.
const org = computed<AdminOrg | null>(() => {
  const orgId = currentBaseRef()?.orgId;
  return orgs.value.find((o) => o.id === orgId) ?? orgs.value[0] ?? null;
});
const isAdmin = computed(() => org.value?.myRole === "admin");

function notify(msg: string) {
  flash.value = msg; error.value = null;
  window.setTimeout(() => { if (flash.value === msg) flash.value = null; }, 4000);
}
function fail(e: unknown) { error.value = e instanceof Error ? e.message : String(e); }

async function load() {
  loading.value = true; error.value = null;
  try { orgs.value = await apiV3.admin.orgs(); }
  catch (e) { fail(e); }
  finally { loading.value = false; }
}

function showInviteResult(r: InviteResult) {
  if (r.emailSent) notify(`Invitation envoyée à ${r.email} (${r.role}).`);
  else if (r.inviteLink) invite.value = { email: r.email, link: r.inviteLink };
  else notify(`${r.email} ajouté·e (${r.role}).`);
}

async function addMember() {
  if (!org.value || !inviteForm.value.email.trim() || busy.value) return;
  busy.value = true; invite.value = null;
  try {
    const r = await apiV3.admin.invite(org.value.slug, inviteForm.value.email.trim(), inviteForm.value.role);
    showInviteResult(r);
    inviteForm.value.email = "";
    await load();
  } catch (e) { fail(e); }
  finally { busy.value = false; }
}

async function changeRole(userId: string, role: OrgRole) {
  if (!org.value || busy.value) return;
  busy.value = true;
  try { await apiV3.admin.setRole(org.value.slug, userId, role); notify("Rôle mis à jour."); await load(); }
  catch (e) { fail(e); await load(); }
  finally { busy.value = false; }
}

async function removeMember(userId: string) {
  if (!org.value || busy.value) return;
  busy.value = true;
  try { await apiV3.admin.removeMember(org.value.slug, userId); confirmRemove.value = null; notify("Membre retiré."); await load(); }
  catch (e) { fail(e); }
  finally { busy.value = false; }
}

function startRename() {
  renameTo.value = org.value?.base?.name ?? "";
  renaming.value = true;
}
async function saveRename() {
  if (!org.value?.base || !renameTo.value.trim() || busy.value) return;
  busy.value = true;
  try {
    await apiV3.admin.renameBase(org.value.base.id, renameTo.value.trim());
    renaming.value = false;
    notify("Base renommée.");
    await Promise.all([load(), loadBases()]);
  } catch (e) { fail(e); }
  finally { busy.value = false; }
}

async function createOrg() {
  if (!newOrg.value.trim() || busy.value) return;
  busy.value = true;
  try {
    const r = await apiV3.admin.createOrg(newOrg.value.trim());
    newOrg.value = "";
    notify(`Organisation « ${r.name} » créée (base « ${r.baseName} »).`);
    await Promise.all([load(), loadBases()]);
  } catch (e) { fail(e); }
  finally { busy.value = false; }
}

async function copyLink() {
  if (!invite.value) return;
  try { await navigator.clipboard.writeText(invite.value.link); notify("Lien copié."); } catch { /* copie manuelle */ }
}

watch(currentBase, () => { invite.value = null; confirmRemove.value = null; renaming.value = false; });
onMounted(load);
</script>

<template>
  <section class="org">
    <header class="head">
      <h1>Organisation &amp; équipe</h1>
      <p class="sub">Membres, rôles et invitations de l'organisation qui détient la base active.</p>
    </header>

    <p v-if="flash" class="flash">{{ flash }}</p>
    <p v-if="error" class="err">{{ error }}</p>

    <div v-if="invite" class="invite">
      <p>Compte créé pour <strong>{{ invite.email }}</strong> — transmets-lui ce lien (valable une fois) :</p>
      <div class="invite-link">
        <input :value="invite.link" readonly @focus="(e) => (e.target as HTMLInputElement).select()" />
        <button class="btn" @click="copyLink">Copier</button>
        <button class="btn ghost" @click="invite = null">Fermer</button>
      </div>
      <p class="muted small">Lien à usage unique — les aperçus (WhatsApp, Slack…) peuvent le consommer. Préfère l'email.</p>
    </div>

    <p v-if="loading" class="muted">Chargement…</p>

    <template v-else-if="org">
      <header class="org-head">
        <h2>{{ org.name }} <span class="slug">{{ org.slug }}</span></h2>
        <span class="badge" :class="org.myRole ?? ''">{{ org.myRole }}</span>
      </header>

      <!-- Base (1 par org) -->
      <section class="card">
        <h3>Base de connaissances</h3>
        <div v-if="!renaming" class="base-row">
          <span class="base-name">{{ org.base?.name ?? "—" }}</span>
          <button v-if="isAdmin && org.base" class="btn ghost" @click="startRename">Renommer</button>
        </div>
        <div v-else class="base-edit">
          <input v-model="renameTo" class="inp" type="text" @keyup.enter="saveRename" />
          <button class="btn primary" :disabled="busy" @click="saveRename">Enregistrer</button>
          <button class="btn ghost" :disabled="busy" @click="renaming = false">Annuler</button>
        </div>
      </section>

      <!-- Membres -->
      <section class="card">
        <h3>Membres</h3>
        <table class="members">
          <thead><tr><th>Membre</th><th>Rôle</th><th></th></tr></thead>
          <tbody>
            <tr v-for="m in org.members" :key="m.userId">
              <td>
                {{ m.email ?? m.userId.slice(0, 12) + "…" }}
                <span v-if="m.pending" class="badge pending" title="Compte jamais connecté">en attente</span>
              </td>
              <td>
                <select
                  v-if="isAdmin"
                  class="role-select"
                  :value="m.role"
                  :disabled="busy"
                  @change="changeRole(m.userId, ($event.target as HTMLSelectElement).value as OrgRole)"
                >
                  <option value="admin">admin</option>
                  <option value="member">member</option>
                </select>
                <span v-else class="badge" :class="m.role">{{ m.role }}</span>
              </td>
              <td class="right">
                <template v-if="isAdmin">
                  <template v-if="confirmRemove === m.userId">
                    <span class="muted small">Retirer&nbsp;?</span>
                    <button class="btn ghost danger" :disabled="busy" @click="removeMember(m.userId)">Oui</button>
                    <button class="btn ghost" :disabled="busy" @click="confirmRemove = null">Non</button>
                  </template>
                  <button v-else class="btn ghost danger" @click="confirmRemove = m.userId">Retirer</button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>

        <form v-if="isAdmin" class="add" @submit.prevent="addMember">
          <input v-model="inviteForm.email" class="inp" type="email" placeholder="email@exemple.com" required />
          <select v-model="inviteForm.role" class="role-select">
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button class="btn primary" type="submit" :disabled="busy">Inviter</button>
        </form>
        <p v-else class="muted small">Lecture seule — réservé aux admins de l'org.</p>
      </section>
    </template>

    <p v-else-if="!loading" class="muted">Aucune organisation accessible.</p>

    <!-- Créer une nouvelle org -->
    <section class="card">
      <h3>Nouvelle organisation</h3>
      <p class="muted small">Une organisation = un périmètre de partage (mission, client). Sa base est créée d'office.</p>
      <form class="add" @submit.prevent="createOrg">
        <input v-model="newOrg" class="inp" type="text" placeholder="Nom de l'organisation" required />
        <button class="btn primary" type="submit" :disabled="busy">Créer</button>
      </form>
    </section>
  </section>
</template>

<style scoped>
.org { max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem 4rem; color: var(--color-ink, #1a1a1a); }
.head { margin-bottom: 1.5rem; }
.head h1 { font-family: var(--font-display, serif); font-size: 1.7rem; margin: 0 0 0.25rem; }
.sub { color: var(--color-mute, #6b6b6b); margin: 0; }
.muted { color: var(--color-mute, #6b6b6b); }
.small { font-size: 0.85rem; }

.org-head { display: flex; align-items: center; gap: 0.6rem; margin: 0 0 1rem; }
.org-head h2 { font-family: var(--font-display, serif); font-size: 1.25rem; margin: 0; }
.slug { font-family: var(--font-mono, monospace); font-size: 0.75rem; color: var(--color-mute, #6b6b6b); margin-left: 0.4rem; }

.card { border: 1px solid var(--color-hair, #e5e2dc); background: var(--color-surface, #fff); border-radius: 8px; padding: 1rem 1.1rem; margin-bottom: 1.1rem; }
.card h3 { margin: 0 0 0.7rem; font-size: 0.95rem; }

.base-row { display: flex; align-items: center; gap: 0.8rem; }
.base-name { font-weight: 600; }
.base-edit { display: flex; gap: 0.4rem; flex-wrap: wrap; }

.members { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.members th { text-align: left; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-mute, #6b6b6b); padding: 0.3rem 0.4rem; border-bottom: 1px solid var(--color-hair, #e5e2dc); }
.members td { padding: 0.5rem 0.4rem; border-bottom: 1px solid var(--color-hair, #e5e2dc); }
.right { text-align: right; white-space: nowrap; }

.badge { font-family: var(--font-mono, monospace); font-size: 0.65rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; padding: 0.1rem 0.4rem; border-radius: 4px; background: var(--color-bg, #faf9f7); border: 1px solid var(--color-hair, #e5e2dc); color: var(--color-mute, #6b6b6b); }
.badge.admin { background: #f3e8e2; color: #8a2d10; border-color: #e8b9a8; }
.badge.pending { margin-left: 0.4rem; background: #fdf2ee; color: #8a2d10; border-color: #e8b9a8; }

.role-select, .inp { font: inherit; font-size: 0.88rem; padding: 0.35rem 0.5rem; border: 1px solid var(--color-hair, #e5e2dc); border-radius: 6px; background: var(--color-bg, #faf9f7); color: var(--color-ink, #1a1a1a); }
.add { display: flex; gap: 0.4rem; margin-top: 0.9rem; flex-wrap: wrap; }
.add .inp { flex: 1; min-width: 180px; }

.btn { font: inherit; font-size: 0.85rem; padding: 0.4rem 0.85rem; border-radius: 6px; border: 1px solid var(--color-hair, #e5e2dc); background: var(--color-surface, #fff); color: var(--color-ink, #1a1a1a); cursor: pointer; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary { background: var(--color-primary, #b5532a); border-color: var(--color-primary, #b5532a); color: #fff; }
.btn.ghost { background: transparent; }
.btn.ghost.danger { color: #a23b1c; border-color: #e8b9a8; }

.flash { background: var(--color-bg, #faf9f7); border: 1px solid var(--color-hair, #e5e2dc); border-left: 3px solid var(--color-primary, #b5532a); padding: 0.6rem 0.8rem; border-radius: 6px; margin: 0 0 1rem; }
.err { background: #fdf2ee; border: 1px solid #e8b9a8; color: #8a2d10; padding: 0.6rem 0.8rem; border-radius: 6px; margin: 0 0 1rem; }
.invite { border: 1px solid var(--color-primary, #b5532a); background: #fbf1ec; border-radius: 8px; padding: 0.9rem 1rem; margin-bottom: 1.1rem; }
.invite-link { display: flex; gap: 0.4rem; margin: 0.5rem 0; flex-wrap: wrap; }
.invite-link input { flex: 1; min-width: 220px; font-family: var(--font-mono, monospace); font-size: 0.75rem; padding: 0.4rem 0.5rem; border: 1px solid var(--color-hair, #e5e2dc); border-radius: 6px; }
</style>
