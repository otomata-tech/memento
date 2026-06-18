# Memento — notifications & activity feed (RFC)

Status: **draft RFC, not implemented** (2026-06-18). Prefix `mem_`. Canonical
schema once built: `server/src/schema.ts` (Drizzle); MCP surface
`supabase/functions/mcp/index.ts`; REST mirror `supabase/functions/api/index.ts`.

> **One substrate, three channels.** Three asks — a transactional email service
> (Resend), an in-app "mailbox / change log", and a Slack app — are **not three
> features**. They are three *delivery channels* over a single notification
> substrate. Memento already journals every mutation (`mem_revisions`,
> `mem_ingestions`, `mem_comments`); what is missing is *recipients*,
> *read-state*, and *routing*.

---

## 0. Decisions captured (2026-06-18)

| Question | Decision |
|---|---|
| Delivery trigger | **pg_cron + digest** for email/Slack; in-app is instant. Hybrid by priority deferred. |
| Slack depth | **Full interactive app** — OAuth install, bot token, Block Kit buttons to validate/reject an ingestion from Slack. |
| Build order | Phase 1 (substrate + in-app mailbox) → Phase 2 (Resend) → Phase 3 (Slack). **This document gates implementation.** |

---

## 1. Why a materialized table (not a derived view)

The journals (`mem_revisions`, `mem_ingestions`, `mem_comments`) already record
*what happened*. A naive feed could `SELECT` over them. We reject that:

- **Read-state is per-recipient.** "Unread" is `(event × user)`, not a property
  of the event. A view cannot carry it.
- **Delivery is a queue.** Email/Slack need `sent_at`, retry, dedup-into-digest.
  A view has no write surface.
- **Recipients are computed once.** The fan-out rule (who cares about this event)
  is evaluated at emit time against the membership/grant graph as it was *then*.

So we **materialize**: one row per `(event, recipient)` in `mem_notifications`.
The cost is a single `notify()` enqueue call at each write site — placed right
next to the existing `mem_revisions` insert, where actor and target are already
in hand.

---

## 2. Data model

Three new tables (Drizzle, `mem_` prefix, `actor`/`user_id` = Supabase `sub` text).

### `mem_notifications`

| Column | Type | Note |
|---|---|---|
| `id` | uuid pk | |
| `recipient` | text | Supabase `sub` of the user to notify |
| `workspace_id` | uuid → `mem_workspaces` | scoping + prefs + mute |
| `event_type` | text | enum, §3 (e.g. `ingestion.pending`) |
| `priority` | text | `high` \| `normal` \| `low` |
| `target_type` | text | `block` \| `document` \| `section` \| `ingestion` \| `comment` \| `workspace` \| `grant` |
| `target_id` | text | polymorphic id |
| `actor` | text | `sub` who caused the event (null = system/agent) |
| `actor_kind` | text | `human` \| `agent` \| `system` |
| `payload` | jsonb | denormalized snippet for rendering (title, excerpt, diff summary) — so the feed never re-joins |
| `read_at` | timestamptz null | in-app read-state |
| `email_state` | text | `none` \| `pending` \| `sent` \| `skipped` (muted/prefs) |
| `slack_state` | text | same enum |
| `created_at` | timestamptz | default now |

Indexes: `(recipient, read_at)` (mailbox), `(email_state) where email_state='pending'`,
`(slack_state) where slack_state='pending'`, `(recipient, workspace_id, created_at)`.

`payload` is denormalized **on purpose**: a notification must render after its
target is edited or deleted, and the digest job must not fan back out to N joins.

### `mem_notification_prefs`

Per-user, per-workspace, per-channel routing. Absent row = defaults from §4.

| Column | Type | Note |
|---|---|---|
| `user_id` | text | |
| `workspace_id` | uuid null | null = global default for the user |
| `channel` | text | `in_app` \| `email` \| `slack` |
| `min_priority` | text | `high` \| `normal` \| `low` \| `off` (mute) |
| `digest` | bool | email only: batch vs instant (instant reserved for `high`) |

PK `(user_id, workspace_id, channel)`. `workspace_id = null` is the fallback row.

### `mem_watches`

Explicit subscription beyond the implicit rules of §3.

| Column | Type | Note |
|---|---|---|
| `user_id` | text | |
| `target_type` | text | `workspace` \| `document` |
| `target_id` | text | |
| `created_at` | timestamptz | |

PK `(user_id, target_type, target_id)`.

### Slack wiring (Phase 3)

| Table | Role |
|---|---|
| `mem_slack_installs` (org_id, team_id, bot_token, installed_by, scopes) | one Slack workspace install per Memento org (OAuth result) |
| `mem_slack_identities` (user_id, team_id, slack_user_id) | map a Memento `sub` to a Slack user, to DM them |

Bot tokens are secrets → stored encrypted at rest (pgsodium / Vault), never in
plain `jsonb`. See §7.

---

## 3. Event taxonomy & recipient rules

Events are emitted by `notify(event, recipients[])` at the existing write sites.
Recipients are resolved **at emit time** against `mem_memberships` +
`mem_workspace_grants` + `mem_watches`, minus the actor (never notify yourself).

| `event_type` | Emitted from | Implicit recipients |
|---|---|---|
| `ingestion.pending` | `ingestion.ts` `stageChanges()` | curators + admins of the KB |
| `ingestion.applied` / `.rejected` / `.changes_requested` | `ingestion.ts` `applyIngestion()` / `rejectIngestion()` / `requestChanges()` | the ingestion's `createdBy` (proposer) |
| `comment.added` | `write.ts` `addComment()` | block/doc author + watchers of the doc/KB |
| `comment.resolved` | `write.ts` `resolveComment()` | comment author |
| `block.contradicted` / `block.superseded` | `write.ts` (supersede path) | author of the affected block |
| `block.verified` | `write.ts` `verifyBlock()` | block author |
| `grant.added` / `membership.invited` | `grants.ts` / `admin.ts` | the invited user (replaces the raw GoTrue email — §5) |
| `workspace.visibility_changed` / `.archived` / `.transferred` | `workspace_mgmt.ts` | KB members |

**Recipient resolution** lives in one place: `_shared/notify.ts` →
`resolveRecipients(workspaceId, eventType, actor)`. It is the single source of
"who cares", reused by all three channels.

---

## 4. Default routing matrix

Applied when no `mem_notification_prefs` row overrides it.

| Event | Priority | in-app | email | Slack |
|---|---|---|---|---|
| `ingestion.pending` | high | ✓ | ✓ instant | ✓ (interactive) |
| `ingestion.applied/rejected/changes` | normal | ✓ | digest | ✓ |
| `comment.added` | normal | ✓ | digest | – |
| `block.contradicted/superseded` | normal | ✓ | digest | – |
| `block.verified` | low | ✓ | – | – |
| `grant.added` / `membership.invited` | high | ✓ | ✓ instant | – |
| `workspace.visibility_changed/archived` | low | ✓ | – | – |

> **Killer notification:** `ingestion.pending` → curators. Memento's whole model
> is propose-validate; an agent's proposal sitting unseen is the system's main
> failure mode. This one event justifies the substrate on its own.

---

## 5. Delivery — pg_cron + digest

In-app is free: the row exists the moment `notify()` runs; the mailbox reads it.

Email & Slack are drained by a **scheduled Edge Function** `notify-drain`,
triggered by `pg_cron` (e.g. every 2 min). Per run:

1. **Instant lane** — `email_state='pending' AND priority='high'`: send one email
   per notification immediately (validation requests, invitations).
2. **Digest lane** — remaining `pending`, grouped by `(recipient)` over the last
   window: one email summarizing N events ("3 comments, 1 ingestion applied").
   Marked `sent` together.
3. **Slack lane** — `slack_state='pending'`: post to the recipient's DM (or the
   org's configured channel) via the install's bot token.

Failures: leave `pending`, bump a `retry_count` (add column if needed), drop to
`skipped` after K attempts and log to `mem_usage_logs` (existing telemetry).

`pg_cron` schedule + the `net.http_post` call to the function live in a migration
(`server/drizzle/00xx_notify_cron.sql`), mirroring how Supabase schedules edge
work. The function URL + a shared secret guard the endpoint.

### Resend

- Single dependency on the Resend HTTP API (no SMTP). Secret `RESEND_API_KEY`.
- Templates: start with **server-rendered HTML strings** in `_shared/email/`
  (no React Email build step in the Deno edge runtime). One template per layout:
  `instant-action` (CTA button → deep link into the app) and `digest`.
- **Migrate invitations off raw GoTrue**: today `admin.ts` relies on GoTrue's
  default invite email. Phase 2 routes `membership.invited` / `grant.added`
  through Resend with a branded template + an explicit accept link
  (`generateInviteLink()` already exists as the fallback path — promote it to
  the primary path and email it ourselves).

---

## 6. Slack app (Phase 3, interactive)

Full app, not an incoming webhook — the goal is to **act from Slack**.

- **Install flow**: OAuth v2. `GET /slack/install` → Slack consent →
  `GET /slack/oauth/callback` stores `mem_slack_installs` (team_id, bot_token,
  scopes `chat:write`, `commands`, `users:read.email`). One install per Memento
  org; an org-admin connects it.
- **Identity mapping**: match Slack users to Memento `sub` by email
  (`users:read.email` ↔ `auth.users.email`), cached in `mem_slack_identities`.
  Unmapped recipients fall back to the org channel.
- **Outbound**: `notify-drain` Slack lane posts a Block Kit message. For
  `ingestion.pending`, the blocks include **Approve / Reject / Request changes**
  buttons carrying the `ingestion_id`.
- **Interactivity**: `POST /slack/interactive` — verify the Slack **signing
  secret** (`x-slack-signature`, timestamp window), resolve the Slack user →
  Memento `sub`, assert that user's write access to the KB, then call the same
  `applyIngestion()` / `rejectIngestion()` / `requestChanges()` used by MCP. The
  Slack action is just another caller of the existing verbs — no business logic
  duplicated.
- **Slash command** (optional): `/memento pending` lists ingestions awaiting the
  caller's validation.

Secrets: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.

---

## 7. API & UI

### REST / MCP surface (additions)

- `GET /api/notifications?unread=1&workspace=:ws` — the mailbox feed (paged,
  keyset on `created_at`).
- `POST /api/notifications/read` `{ids[]}` / `POST /api/notifications/read-all`.
- `GET/PUT /api/notification-prefs` — per-workspace/channel prefs.
- `POST /api/watches` / `DELETE /api/watches` — watch/unwatch a doc/KB.
- MCP mirror verbs (`mem_notifications`, `mem_mark_read`, `mem_watch`) so an
  agent can also read "what changed since I last looked".

### UI (Vue 3, `app/src/`)

- **Badge + dropdown** in `components/AppShell.vue` top bar (next to the account
  menu): unread count, latest items, "mark all read".
- **Full page** `views/InboxView.vue` at route `/inbox` (cross-workspace) and
  `/w/:ws/inbox` (scoped): grouped by day, filter by type, link straight to the
  target (block/doc/ingestion in `LoopView.vue`).
- **Prefs** surface in `OrgView.vue` / account settings: per-KB channel toggles.
- Client types + calls in `app/src/api.ts` (mirror existing `Block` /
  `IngestionDetail` patterns).

---

## 8. Secrets & config

New platform secrets (Supabase project, never versioned):

| Secret | Channel |
|---|---|
| `RESEND_API_KEY` | email |
| `NOTIFY_CRON_SECRET` | guards the `notify-drain` endpoint |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` | Slack |

Reminder (repo is **public**): all of the above are read from
`ctx.env` / platform secrets — **never** hardcoded, never committed. Bot tokens
in `mem_slack_installs` are encrypted at rest.

---

## 9. Phasing

0. **Phase 0 — invitation emails via a real provider (ships ahead, independent).**
   Today invitations rely on GoTrue's default email. Wire Resend
   (`RESEND_API_KEY`) and route `membership.invited` / `grant.added` through a
   branded template with an explicit accept link (`generateInviteLink()` already
   exists as the fallback — promote it to primary). This needs **none** of the
   notification substrate and lands first.
1. **Phase 1 — substrate + in-app mailbox.** `mem_notifications`, `mem_watches`,
   `notify()` + `resolveRecipients()` at the write sites, REST/MCP read verbs,
   badge + inbox in the UI. No external dependency. Immediately useful.
2. **Phase 2 — Resend.** `mem_notification_prefs`, `notify-drain` + pg_cron,
   instant + digest email templates, invitations migrated off raw GoTrue.
3. **Phase 3 — Slack app.** OAuth install, identity mapping, outbound Block Kit,
   interactive endpoint reusing the ingestion verbs, optional slash command.

Each phase ships independently; Phase 1 is the hard dependency of 2 and 3.

---

## 10. Open questions

- **Agent recipients.** `ingestion.applied/rejected` targets the *proposer*,
  often an agent (no inbox). Do we notify the human who runs the agent, surface
  it only in-app/MCP, or both? (Leaning: in-app + MCP read verb; no email.)
- **Digest window & cadence.** 2 min cron is the drain tick; the digest *window*
  (how far back a single email reaches) is separate — daily? hourly? per-user?
- **Per-section granularity.** Recipients are whole-KB today (matches
  `access-control.md` "no fractal ACLs"). Watching a single document is the only
  sub-KB grain we add (`mem_watches`); keep it there.
- **Anonymous / public KBs.** Public-read users have no identity → never
  notified. Confirm no notification path leaks identities on public surfaces
  (consistent with the hidden revision journal for anonymous viewers).
