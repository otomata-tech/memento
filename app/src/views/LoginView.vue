<script setup lang="ts">
/**
 * Sign-in / sign-up to the Memento viewer (email/password via Supabase).
 * Access guard: the router redirects here when there is no session.
 * A fresh account lands in the app, where the backend auto-provisions a personal
 * org + base on first access (ensurePersonalBaseV3, issue #70) — no dead end.
 */
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { supabase, signInWithGoogle } from "../auth";

const route = useRoute();
const router = useRouter();
const mode = ref<"signin" | "signup">("signin");
const email = ref("");
const password = ref("");
const busy = ref(false);
const sent = ref(false);
const error = ref("");
// Auto-connect: a live session already exists → no form, go straight in.
// (Otherwise: reflexive re-login on every arrival at /login, abandoned sessions in series.)
const checking = ref(true);
onMounted(async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) { router.replace(dest()); return; }
  checking.value = false;
});

function dest() {
  const r = route.query.redirect;
  // same-origin relative path only ("//host" = protocol-relative → external)
  return typeof r === "string" && r.startsWith("/") && !r.startsWith("//") ? r : "/";
}

async function signInPassword() {
  busy.value = true; error.value = "";
  const { error: e } = await supabase.auth.signInWithPassword({ email: email.value, password: password.value });
  busy.value = false;
  if (e) { error.value = e.message; return; }
  router.replace(dest());
}

async function signUpPassword() {
  if (password.value.length < 8) { error.value = "8 characters minimum."; return; }
  busy.value = true; error.value = "";
  const emailRedirectTo = `${window.location.origin}/callback`;
  const { data, error: e } = await supabase.auth.signUp({
    email: email.value, password: password.value, options: { emailRedirectTo },
  });
  busy.value = false;
  if (e) { error.value = e.message; return; }
  // Confirmations off → a session is returned immediately; on → confirm by email first.
  if (data.session) { router.replace(dest()); return; }
  sent.value = true;
}

function toggleMode() {
  mode.value = mode.value === "signin" ? "signup" : "signin";
  error.value = "";
}

async function signInOtp() {
  error.value = "";
  const redirectTo = `${window.location.origin}/callback`;
  const { error: e } = await supabase.auth.signInWithOtp({ email: email.value, options: { emailRedirectTo: redirectTo } });
  if (e) { error.value = e.message; return; }
  sent.value = true;
}

async function signInGoogle() {
  error.value = "";
  const e = await signInWithGoogle(`${window.location.origin}/callback`);
  if (e) error.value = e; // otherwise redirect to Google
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card" v-if="!checking">
      <div class="brand">Memento</div>
      <h1 class="title">{{ mode === "signup" ? "Create your account" : "Sign in" }}</h1>
      <p v-if="sent" class="muted">Link sent to {{ email }} — click it to {{ mode === "signup" ? "activate your account" : "sign in" }}.</p>
      <template v-else>
        <p class="muted">{{ mode === "signup" ? "Create an account to start your own knowledge base." : "Sign in to browse the knowledge base." }}</p>
        <button type="button" class="google" @click="signInGoogle">Continue with Google</button>
        <div class="sep"><span>or</span></div>
        <form v-if="mode === 'signup'" @submit.prevent="signUpPassword">
          <input v-model="email" type="email" placeholder="your.email@…" required class="field" />
          <input v-model="password" type="password" placeholder="password (8+ characters)" autocomplete="new-password" required class="field" />
          <div class="actions">
            <button type="submit" :disabled="busy">{{ busy ? "…" : "Create account" }}</button>
          </div>
        </form>
        <form v-else @submit.prevent="signInPassword">
          <input v-model="email" type="email" placeholder="your.email@…" required class="field" />
          <input v-model="password" type="password" placeholder="password" required class="field" />
          <div class="actions">
            <button type="submit" :disabled="busy">{{ busy ? "…" : "Sign in" }}</button>
            <button type="button" class="ghost" @click="signInOtp">Email link</button>
          </div>
        </form>
        <p v-if="error" class="muted err">{{ error }}</p>
        <p class="muted switch">
          <template v-if="mode === 'signup'">Already have an account? <button type="button" class="link" @click="toggleMode">Sign in</button></template>
          <template v-else>No account yet? <button type="button" class="link" @click="toggleMode">Create one</button></template>
        </p>
      </template>
      <p class="pubentry"><router-link to="/public">Explore public bases →</router-link></p>
    </div>
  </div>
</template>

<style scoped>
.login-wrap { display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; }
.login-card { width: 100%; max-width: 420px; border: 1px solid var(--color-hair); background: var(--color-surface); padding: 28px; }
.login-card .brand { font-family: var(--font-display); font-weight: 700; font-size: 16px; color: var(--color-primary-ink); margin-bottom: 18px; }
.login-card .title { font-size: 22px; margin: 0 0 8px; }
.field { display: block; width: 100%; padding: 9px 11px; margin-top: 10px; border: 1px solid var(--color-hair); background: var(--color-bg); font-family: inherit; }
.field:focus { outline: 2px solid var(--color-primary); }
button { border: 1px solid var(--color-ink); background: var(--color-ink); color: var(--color-bg); padding: 9px 16px; font-weight: 600; font-size: 14px; }
button.ghost { background: none; color: var(--color-ink); }
button.google { width: 100%; margin-top: 16px; background: none; color: var(--color-ink); border: 1px solid var(--color-hair); }
button.google:hover { background: var(--color-bg); }
.sep { display: flex; align-items: center; gap: 10px; margin: 16px 0 4px; color: var(--color-mute); font-size: 12px; }
.sep::before, .sep::after { content: ""; flex: 1; height: 1px; background: var(--color-hair); }
.actions { display: flex; gap: 10px; margin-top: 20px; }
.err { color: var(--color-danger, #b00); margin-top: 12px; }
.switch { margin-top: 16px; font-size: 13px; }
.switch .link { border: none; background: none; color: var(--color-primary-ink, var(--color-ink)); padding: 0; font-weight: 600; font-size: 13px; cursor: pointer; text-decoration: underline; }
.pubentry { margin: 20px 0 0; padding-top: 16px; border-top: 1px solid var(--color-hair); font-size: 13px; }
.pubentry a { color: var(--color-primary-ink, var(--color-ink)); text-decoration: none; }
.pubentry a:hover { text-decoration: underline; }
</style>
