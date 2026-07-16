import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { supabase } from "./auth";
import { isSiteHost, APP_ORIGIN } from "./hosts";

const routes: RouteRecordRaw[] = [
  // Public showcase landing (mento.cc). On the app host, the guard redirects "/" to the
  // cockpit (logged in) or /login. Kept because mento.cc serves it as the marketing page.
  { path: "/", component: () => import("./views/HomeView.vue") },
  { path: "/plugin", component: () => import("./views/PluginView.vue") },
  // Viewer page-centré — le cockpit. Shell (V3Layout) + vues, à la RACINE (URLs sans /v3).
  // Le parent porte le home du cockpit (/pages) ; les enfants sont en chemins ABSOLUS
  // (`/page/:id`, `/search`…) → ils s'affichent DANS le shell mais avec une URL propre.
  {
    path: "/pages", component: () => import("./views/v3/V3Layout.vue"),
    children: [
      { path: "", component: () => import("./views/v3/PagesView.vue") },
      { path: "/page/:id", component: () => import("./views/v3/PagesView.vue") },
      { path: "/search", component: () => import("./views/v3/SearchView.vue") },
      { path: "/inbox", component: () => import("./views/v3/InboxView.vue") },
      { path: "/org", component: () => import("./views/v3/OrgView.vue") },
      { path: "/connector", component: () => import("./views/v3/ConnectorView.vue") },
      { path: "/entity/:id", component: () => import("./views/v3/EntityView.vue") },
    ],
  },
  // Rétro-compat : les anciens liens /v3/* (déjà partagés) redirigent vers la racine.
  { path: "/v3", redirect: "/pages" },
  { path: "/v3/page/:id", redirect: (to) => `/page/${to.params.id}` },
  { path: "/v3/entity/:id", redirect: (to) => `/entity/${to.params.id}` },
  { path: "/v3/search", redirect: "/search" },
  { path: "/v3/inbox", redirect: "/inbox" },
  { path: "/v3/org", redirect: "/org" },
  { path: "/v3/connector", redirect: "/connector" },
  // Non-editorial
  { path: "/login", component: () => import("./views/LoginView.vue") },
  { path: "/oauth/consent", component: () => import("./views/ConsentView.vue") },
  { path: "/callback", component: () => import("./views/CallbackView.vue") },
  { path: "/:catchAll(.*)", redirect: "/" },
];

const router = createRouter({ history: createWebHistory(), routes });

// Public pages (handle their own auth); everything else requires a session.
const PUBLIC = new Set(["/", "/plugin", "/login", "/oauth/consent", "/callback"]);
// On the showcase domain (mento.cc), only these pages remain; the rest goes to the app.
const SITE_PUBLIC = new Set(["/", "/plugin"]);

router.beforeEach(async (to) => {
  // mento.cc = showcase: anything that is not a site page (login, viewer, oauth) → app.
  if (isSiteHost() && !SITE_PUBLIC.has(to.path)) {
    window.location.href = APP_ORIGIN + to.fullPath;
    return false;
  }
  // Pre-check on "/" (outside the showcase) BEFORE mounting the landing: getSession is
  // local (storage, no network) — logged in → the cockpit, otherwise → login.
  // The landing only shows on mento.cc.
  if (to.path === "/" && !isSiteHost()) {
    const { data: { session } } = await supabase.auth.getSession();
    return session ? { path: "/pages" } : { path: "/login" };
  }
  if (PUBLIC.has(to.path)) return true;
  // Reading a page/entity by link: tolerated without a session — a `public` page is
  // shareable (the API serves only the public scope for sub=""). Editing stays gated (401).
  if (/^\/(page|entity)\//.test(to.path)) return true;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { path: "/login", query: { redirect: to.fullPath } };
  return true;
});

export default router;
