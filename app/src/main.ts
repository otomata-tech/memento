import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import "./style.css";
import "./assets/editorial.css";
import { initAnalytics, identifyUser, resetUser } from "./lib/analytics";
import { supabase } from "./auth";

// Analytics PostHog (EU) + consent gate — no-op without VITE_POSTHOG_KEY (dev).
initAnalytics();
// me.mento.cc (authenticated): tie the PostHog session to the Supabase user.
// onAuthStateChange also fires INITIAL_SESSION → covers an already-signed-in load.
supabase.auth.onAuthStateChange((_event, session) => {
  if (session?.user) identifyUser(session.user.id, { email: session.user.email ?? undefined });
  else resetUser();
});

createApp(App).use(router).mount("#app");
