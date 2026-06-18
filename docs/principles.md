# Memento — the principles

*Memento mori — note everything.*

Memento is a **knowledge substrate for agents**: structured, sourced, living
and auditable, consumed via MCP. This document explains the *why* in a few
minutes of reading — no implementation detail. For the *how*: the
[founding spec](specs/knowledge-base.md); to connect to it:
[connect-mcp](connect-mcp.md).

## The problem

A document RAG stores a **bag of documents**: you retrieve passages, not
knowledge. What it lacks to represent **know-how** — concepts, rules,
exceptions, procedures — is:

- knowing **where** each statement comes from (and whether it still holds);
- linking the pieces together (this rule *depends on* that principle,
  *contradicts* that older note);
- letting the base **evolve** without degrading: who changed what, why, and
  with which validation.

Wikis do this for humans, poorly for agents (no programmable surface, no
addressable atom). Vector stores do it for similarity, not for structure.
Memento fills that gap: **a knowledge base that agents read AND maintain,
under human control.**

## The six ideas

### 1. The block is the atom

The unit is neither the document nor the chunk: it is the **typed block**
(principle, rule, exception, example, procedure, caveat, definition…). Each
block is addressable, and everything attaches to it: **sources** (where it
comes from), **typed links** to other blocks (`references`, `depends_on`,
`contradicts`, `supersedes`), **comments**, **verification status**. A block
that would need two sources for two statements must be split: fine grain is the
guarantee of auditability.

### 2. Constraint at the top, freedom at the bottom

Every base ("workspace") has a **backbone**: a strict, shallow section tree
(≤ 3 levels) that holds the mental map. Below it, documents freely compose
blocks. The structure does not drift, the content breathes.

### 3. Doctrine-first

An agent never "vacuums up" the base. It starts with `mem_doctrine`: a
**compact map** (meta-instruction preamble + section tree + conventions),
always loadable into context. Then it drills — 2-3 sections, a document, a
block. The server never returns an unrequested wall of text.

### 4. Dumb server, smart agent

The server stores, guarantees invariants (invalid states are impossible) and
journals intent. **No LLM on the server side.** Claim extraction,
classification, judgment: that is the calling agent. Corollary:
**intelligence is at write time, reads are deterministic** — you pay the cost
of structuring once, at the entrance, and every subsequent read is reliable and
cheap.

### 5. Propose-validate: nothing enters without review

Knowledge ingestion goes through a loop: the agent **proposes** a classified
change-set (`CONFIRM` / `ENRICH` / `CONTRADICT` / `OBSOLETE`), a human
**reviews**, then the change-set is applied — transactionally, with a motivated
revision per operation. **Contradictions are never auto-applied**: that is the
precious case, the one that deserves human arbitration. The whole history is a
journal of intent ("why" included), not a raw diff.

### 6. One base = one sharing perimeter

Multi-workspace does not split by technical project but by **sharing
perimeter**: one base per mission/client, one personal base. Access follows: an
organization owns the base, its members access it according to their role
(admin / curator / member). No catch-all "general" base.

## What it enables

- An agent (claude.ai, Claude Code…) that **consults the doctrine before
  acting** and cites its sources down to the block.
- A watch process that **continuously enriches the base** without ever
  overwriting it: each contribution is proposed, classified, reviewed.
- Knowledge that **survives reorganizations**: sources stay anchored to blocks,
  the journal keeps the why of each mutation.
- Several airtight bases (clients, personal) served by **the same server**, the
  same account, the same connector.

## Going further

- [Founding spec](specs/knowledge-base.md) — data model, MCP surface (39 `mem_*`
  verbs), invariants, ingestion loop walked through.
- [Upstream research](research/) — agentic memory & retrieval (pedagogical
  synthesis + sourced sheet); grounds "intelligence at write time / deterministic
  reads".
- [Access control](access-control.md) — orgs, memberships, roles.
- [Deployment](deployment-edge.md) — prod topology (Cloudflare Pages + Supabase Edge).
- [Connecting](connect-mcp.md) — wiring Memento to claude.ai or Claude Code.
