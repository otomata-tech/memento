import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { supabase } from "./auth";
import { api } from "./api";
import { isSiteHost, APP_ORIGIN } from "./hosts";

/** /org and /admin (compat) → the page of the caller's first org. */
async function firstOrgRedirect() {
  try {
    const r = await api.admin.orgs();
    const slug = r.orgs[0]?.slug;
    if (slug) return `/org/${slug}/bases`;
  } catch { /* not logged in: the global guard will redirect to /login */ }
  return "/";
}

const routes: RouteRecordRaw[] = [
  // Public home (logged in: redirected to the default KB by the guard)
  { path: "/", component: () => import("./views/HomeView.vue") },
  { path: "/plugin", component: () => import("./views/PluginView.vue") },
  // Public gallery: directory + search of public KBs (no account)
  { path: "/public", component: () => import("./views/PublicGalleryView.vue") },
  // Read — the block reader
  { path: "/w/:ws", component: () => import("./views/ReaderView.vue") },
  { path: "/w/:ws/section/:id", component: () => import("./views/ReaderView.vue") },
  { path: "/w/:ws/doc/:id", component: () => import("./views/ReaderView.vue") },
  { path: "/w/:ws/search", component: () => import("./views/ReaderView.vue") },
  // Agent mode — full-screen chat (standalone) on the KB
  { path: "/w/:ws/agent", component: () => import("./views/AgentView.vue") },
  // Graph
  { path: "/w/:ws/graph", component: () => import("./views/GraphView.vue") },
  { path: "/w/:ws/graph/:blockId", component: () => import("./views/GraphView.vue") },
  // Loop (per-KB) + global cross-org/cross-KB inbox
  { path: "/w/:ws/loop", component: () => import("./views/LoopView.vue") },
  { path: "/inbox", component: () => import("./views/InboxView.vue") },
  // Organizations — management per org (tabs), org switched from the bar
  { path: "/org/:org/:tab(bases|membres|reglages)", component: () => import("./views/OrgView.vue") },
  { path: "/org/:org", redirect: (to) => `/org/${to.params.org}/bases` },
  { path: "/org", beforeEnter: firstOrgRedirect, component: () => import("./views/HomeView.vue") },
  // Platform view (server gating: MEMENTO_PLATFORM_ADMINS; others see the denial)
  { path: "/comptes", component: () => import("./views/AccountsView.vue") },
  { path: "/admin", beforeEnter: firstOrgRedirect, component: () => import("./views/HomeView.vue") }, // compat
  // Non-editorial
  { path: "/login", component: () => import("./views/LoginView.vue") },
  { path: "/oauth/consent", component: () => import("./views/ConsentView.vue") },
  { path: "/callback", component: () => import("./views/CallbackView.vue") },
  { path: "/:catchAll(.*)", redirect: "/" },
];

const router = createRouter({ history: createWebHistory(), routes });

// Public pages (handle their own auth); everything else requires a session.
// `/w/:ws…` is anonymous-tolerant: the viewer loads the KB and the API only serves
// the `public` scope (otherwise 403, shown in place). Editing stays gated (401).
const PUBLIC = new Set(["/", "/plugin", "/public", "/login", "/oauth/consent", "/callback"]);
// On the showcase domain (mento.cc), only these pages remain; the rest goes to the app.
const SITE_PUBLIC = new Set(["/", "/plugin"]);

/** Home of a logged-in user: the bases of the org owning their default base, else their first org. Null if the API does not respond. */
async function homePath(): Promise<string | null> {
  try {
    const [r, prefs] = await Promise.all([api.admin.orgs(), api.prefs()]);
    const owning = r.orgs.find((o) => o.workspaces.some((w) => w.slug === prefs.defaultWorkspace));
    const slug = (owning ?? r.orgs[0])?.slug;
    return slug ? `/org/${slug}/bases` : null;
  } catch { return null; }
}

router.beforeEach(async (to) => {
  // mento.cc = showcase: anything that is not a site page (login, viewer, oauth) → app.
  if (isSiteHost() && !SITE_PUBLIC.has(to.path)) {
    window.location.href = APP_ORIGIN + to.fullPath;
    return false;
  }
  // Pre-check on "/" (outside the showcase) BEFORE mounting the landing: getSession is
  // local (storage, no network) — logged in → home (org bases), otherwise → login.
  // The landing only shows on mento.cc or if the API is unavailable.
  if (to.path === "/" && !isSiteHost()) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { path: "/login" };
    return (await homePath()) ?? true;
  }
  if (PUBLIC.has(to.path)) return true;
  // Reading a KB: tolerated without a session (the viewer/API handle access — only
  // the public part passes anonymously). The other routes (org, accounts…) require a login.
  if (to.path.startsWith("/w/")) return true;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { path: "/login", query: { redirect: to.fullPath } };
  return true;
});

export default router;
