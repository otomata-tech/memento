// Shared chrome state — the single source of truth every surface reads (header,
// inbox, loop…). A reactive singleton (Vue 3 composable store; no Pinia needed):
// any surface mutates it through these actions, and all readers update together.
// This is what kills the "badge/menu went stale after an action" class of bugs —
// and the natural sink for future realtime pushes (a socket just writes here).
import { reactive } from "vue";
import { api, type AdminOrg } from "../api";
import { supabase } from "../auth";

type Ref = { slug: string; name: string };

export const shell = reactive({
  authed: false,
  email: null as string | null,
  orgs: [] as AdminOrg[],
  shared: [] as Ref[], // KBs granted outside my orgs
  pins: [] as Ref[],   // pinned public KBs
  favorite: null as string | null,
  platformAdmin: false,
  inboxCount: 0,        // pending ingestions across ALL my KBs
  pending: 0,           // pending ingestions for `pendingWs`
  pendingWs: "",
  realtimeTick: 0,      // bumped on a realtime "inbox changed" push → views refetch their lists
});

/** Auth identity (session + email). Call once at app start / on mount. */
export async function initSession() {
  shell.authed = !!(await supabase.auth.getSession()).data.session;
  shell.email = shell.authed ? (await supabase.auth.getUser()).data.user?.email ?? null : null;
}

/** Orgs + KB selector data + favorite + platform flag. */
export async function loadShell() {
  if (!shell.authed) return;
  try {
    const [r, prefs, all, pinned] = await Promise.all([api.admin.orgs(), api.prefs(), api.workspaces(), api.pinned()]);
    shell.orgs = r.orgs;
    shell.favorite = prefs.defaultWorkspace;
    const inOrgs = new Set(r.orgs.flatMap((o) => o.workspaces.map((w) => w.slug)));
    shell.shared = all.filter((w) => !inOrgs.has(w.slug)).map((w) => ({ slug: w.slug, name: w.name }));
    const known = new Set([...inOrgs, ...shell.shared.map((w) => w.slug)]);
    shell.pins = pinned.filter((w) => !known.has(w.slug)).map((w) => ({ slug: w.slug, name: w.name }));
  } catch { /* the session guard handles the 401 */ }
  try { await api.admin.accounts(); shell.platformAdmin = true; } catch { shell.platformAdmin = false; }
}

/** Global cross-KB pending count (the 📥 badge). */
export async function loadInbox() {
  if (!shell.authed) { shell.inboxCount = 0; return; }
  try { shell.inboxCount = (await api.inbox()).count; } catch { shell.inboxCount = 0; }
}

/** Pending count for one KB (the per-KB Loop badge). */
export async function loadPending(ws: string) {
  shell.pendingWs = ws;
  if (!ws || !shell.authed) { shell.pending = 0; return; }
  try { shell.pending = (await api.ingestions(ws, "PROPOSED")).count; } catch { shell.pending = 0; }
}

/** Invalidate the ingestion counters after an apply/reject/stage, anywhere. */
export async function refreshLoop(ws?: string) {
  await Promise.all([loadInbox(), ws ? loadPending(ws) : Promise.resolve()]);
}
