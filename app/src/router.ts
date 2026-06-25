import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { supabase } from "./auth";
import { api } from "./api";
import { isSiteHost, APP_ORIGIN } from "./hosts";

/** Déploiement v3 page-centré (memento-v3) : `/`, `/home`, `/inbox` pointent sur le viewer v3. */
const V3 = import.meta.env.VITE_MEMENTO_V3 === "true";

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
  // Public landing (logged in: the guard redirects to /home)
  { path: "/", component: () => import("./views/HomeView.vue") },
  // App home: the user's whole universe (all orgs + bases + shared + pinned)
  { path: "/home", component: () => import("./views/HomeUniverseView.vue") },
  { path: "/plugin", component: () => import("./views/PluginView.vue") },
  // V3 — viewer page-centré (déploiement memento-v3). Shell + vues imbriquées.
  {
    path: "/v3", component: () => import("./views/v3/V3Layout.vue"),
    children: [
      { path: "", component: () => import("./views/v3/PagesView.vue") },
      { path: "page/:id", component: () => import("./views/v3/PagesView.vue") },
      { path: "search", component: () => import("./views/v3/SearchView.vue") },
      { path: "inbox", component: () => import("./views/v3/InboxView.vue") },
    ],
  },
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

router.beforeEach(async (to) => {
  // mento.cc = showcase: anything that is not a site page (login, viewer, oauth) → app.
  if (isSiteHost() && !SITE_PUBLIC.has(to.path)) {
    window.location.href = APP_ORIGIN + to.fullPath;
    return false;
  }
  // Pre-check on "/" (outside the showcase) BEFORE mounting the landing: getSession is
  // local (storage, no network) — logged in → /home (the universe), otherwise → login.
  // The landing only shows on mento.cc.
  if (to.path === "/" && !isSiteHost()) {
    const { data: { session } } = await supabase.auth.getSession();
    return session ? { path: V3 ? "/v3" : "/home" } : { path: "/login" };
  }
  // Sur le déploiement v3, les entrées v2 (/home, /inbox) renvoient au viewer v3.
  if (V3 && (to.path === "/home" || to.path === "/inbox")) {
    return { path: to.path === "/inbox" ? "/v3/inbox" : "/v3" };
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
