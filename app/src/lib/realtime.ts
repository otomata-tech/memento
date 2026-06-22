// Live "inbox changed" — Supabase Realtime **Broadcast** (pub/sub, no postgres_changes
// → no row content on the wire). The server pings `inbox-<slug>` whenever an ingestion
// changes; we subscribe only to the KBs the user can see, and on a ping we REFETCH via
// the authorized REST endpoints (the channel carries no data). One write target: the
// shared store, so every surface updates live without navigation.
import { watch } from "vue";
import { supabase } from "../auth";
import { shell, loadInbox, loadPending } from "../stores/shell";

type Channel = ReturnType<typeof supabase.channel>;
let channels: Channel[] = [];
let throttle: ReturnType<typeof setTimeout> | null = null;
let started = false;

function accessibleSlugs(): string[] {
  return [...new Set([
    ...shell.orgs.flatMap((o) => o.workspaces.map((w) => w.slug)),
    ...shell.shared.map((w) => w.slug),
    ...shell.pins.map((w) => w.slug),
  ])];
}

function onPing() {
  // Coalesce bursts (an apply touches many rows → many pings): one refetch / ~400ms.
  if (throttle) return;
  throttle = setTimeout(() => { throttle = null; }, 400);
  loadInbox();
  loadPending(shell.pendingWs);
  shell.realtimeTick++; // lists (InboxView/LoopView) watch this to reload themselves
}

async function resubscribe() {
  for (const ch of channels) await supabase.removeChannel(ch);
  channels = accessibleSlugs().map((slug) =>
    supabase.channel(`inbox-${slug}`).on("broadcast", { event: "changed" }, onPing).subscribe());
}

/** Mount once (App.vue). Re-subscribes as the set of visible KBs changes. */
export function startRealtime() {
  if (started) return;
  started = true;
  resubscribe();
  watch(() => accessibleSlugs().join(","), resubscribe);
}
