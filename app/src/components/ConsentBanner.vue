<script setup lang="ts">
import { computed } from "vue";
import { analyticsEnabled, consent, grantConsent, denyConsent } from "../lib/analytics";

// Shown only when analytics is active (key present) AND no choice has been made.
// In dev (no key) or after a decision: nothing.
const show = computed(() => analyticsEnabled() && consent.value === null);
</script>

<template>
  <Transition name="oconsent">
    <div v-if="show" class="oconsent" role="dialog" aria-label="analytics consent">
      <p class="oconsent__text">
        we use <strong>PostHog</strong> to measure usage and improve Memento. recordings mask
        your inputs. you can decline — nothing is collected before you accept.
        <a href="https://trust.oto.zone" target="_blank" rel="noopener">privacy</a>
      </p>
      <div class="oconsent__actions">
        <button type="button" class="oconsent__btn" @click="denyConsent">decline</button>
        <button type="button" class="oconsent__btn oconsent__btn--primary" @click="grantConsent">
          accept
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.oconsent {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 200;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  background: var(--color-surface);
  border: 1px solid var(--color-hair);
  border-radius: var(--radius-lg, 14px);
  box-shadow: 0 16px 40px -14px rgba(0, 0, 0, 0.28);
  font-family: var(--font-sans);
}
.oconsent__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--color-ink-soft);
}
.oconsent__text strong { color: var(--color-ink); font-weight: 600; }
.oconsent__text a { color: var(--color-primary-ink); text-decoration: underline; }
.oconsent__actions { display: flex; justify-content: flex-end; gap: 8px; }
.oconsent__btn {
  appearance: none;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  padding: 7px 14px;
  border-radius: var(--radius-md, 9px);
  border: 1px solid var(--color-hair);
  background: transparent;
  color: var(--color-ink-soft);
  transition: color 120ms ease, border-color 120ms ease, filter 120ms ease;
}
.oconsent__btn:hover { color: var(--color-ink); border-color: var(--color-ink-soft); }
.oconsent__btn--primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-primary-ink);
}
.oconsent__btn--primary:hover { filter: brightness(0.96); }
.oconsent-enter-active,
.oconsent-leave-active { transition: opacity 200ms ease, transform 200ms ease; }
.oconsent-enter-from,
.oconsent-leave-to { opacity: 0; transform: translateY(8px); }
</style>
