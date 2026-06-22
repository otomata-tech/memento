/**
 * Realtime "inbox changed" signal — Supabase **Broadcast** (pub/sub), deliberately
 * NOT `postgres_changes`: without RLS on mem_ingestions the latter would stream row
 * content to any subscriber. Broadcast carries NO sensitive data — just a per-KB ping;
 * clients refetch through the authorized REST endpoints (/inbox, /ingestions).
 *
 * Topic = `inbox-<workspaceSlug>`. A client subscribes only to the KBs it can see.
 * Fire-and-forget + awaited (edge isolates may freeze after the response, so we don't
 * leave the fetch dangling); never throws into the caller's op.
 */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

export async function broadcastInbox(workspaceSlug: string | undefined): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY || !workspaceSlug) return;
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ messages: [{ topic: `inbox-${workspaceSlug}`, event: "changed", payload: {}, private: false }] }),
    });
  } catch (e) {
    console.error("[realtime] broadcastInbox failed:", e);
  }
}
