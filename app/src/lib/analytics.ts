import posthog from "posthog-js";
import { ref } from "vue";

// Analytics (PostHog Cloud EU) + consent gate for the Memento SPA.
// Serves two surfaces from one build: the public showcase (mento.cc, anonymous)
// and the app (me.mento.cc, authenticated → identified by Supabase user).
//
// Optional by design: without VITE_POSTHOG_KEY the whole module is a no-op (dev).
// Nothing is captured until the visitor accepts on the consent banner.
//
// NB: deliberate copy of the shared @otomata/ui analytics module — this repo is
// standalone (no @otomata/ui dependency, public OSS), so the ~50 lines are ported
// rather than shared. Keep both in sync if the consent logic changes.

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || "https://eu.i.posthog.com";

const CONSENT_KEY = "oto-analytics-consent";
type Consent = "granted" | "denied";

export const consent = ref<Consent | null>(
  typeof localStorage !== "undefined"
    ? ((localStorage.getItem(CONSENT_KEY) as Consent | null) ?? null)
    : null,
);

let enabled = false;
let lastUser: { id: string; props?: Record<string, unknown> } | null = null;

export function analyticsEnabled(): boolean {
  return enabled;
}

export function initAnalytics(): void {
  if (!KEY) return;
  posthog.init(KEY, {
    api_host: HOST,
    // SPA pageviews captured automatically (no router hook needed).
    capture_pageview: "history_change",
    // Anonymous showcase visitors create no profile; app users get one on identify.
    person_profiles: "identified_only",
    // Fully off until explicit consent.
    opt_out_capturing_by_default: true,
    disable_session_recording: true,
    session_recording: { maskAllInputs: true },
  });
  enabled = true;
  if (consent.value === "granted") applyOptIn();
}

function applyOptIn(): void {
  posthog.opt_in_capturing();
  posthog.startSessionRecording();
  if (lastUser) posthog.identify(lastUser.id, lastUser.props);
  posthog.capture("$pageview");
}

// me.mento.cc: link the session to the signed-in user. Memoised so a consent
// granted later in the session still re-identifies.
export function identifyUser(id: string, props?: Record<string, unknown>): void {
  lastUser = { id, props };
  if (enabled) posthog.identify(id, props);
}

export function resetUser(): void {
  lastUser = null;
  if (enabled) posthog.reset();
}

export function grantConsent(): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(CONSENT_KEY, "granted");
  consent.value = "granted";
  if (enabled) applyOptIn();
}

export function denyConsent(): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(CONSENT_KEY, "denied");
  consent.value = "denied";
  if (enabled) posthog.opt_out_capturing();
}
