/**
 * Memento V3 — transport MCP (issue #55). Enrobe la logique des 8 verbes (v3.ts)
 * dans le serveur officiel @modelcontextprotocol/sdk + l'entrée HTTP.
 *
 * SÉPARÉ de v3.ts car le SDK MCP n'expose pas de `.d.ts` → ce fichier n'est pas
 * `deno check`-able (comme l'actuel mcp/index.ts v2) ; il est transpilé par Supabase
 * au déploiement. Toute la logique testable/type-checkée vit dans v3.ts.
 *
 * Cutover : index.ts (entrée Supabase) importera `handleV3Request` d'ici. Local :
 *   DATABASE_URL=… deno run -A supabase/functions/mcp/v3_server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { AccessError, safeErrorMessage } from "../_shared/access.v3.ts";
import {
  authenticate, protectedResourceMetadata, wwwAuthenticate, isDiscoveryPath, authServerMetadata,
} from "../_shared/auth.ts";
import { V3_INSTRUCTIONS } from "../_shared/discoverability.v3.ts";
import {
  LIST_KINDS, v3Apply, v3Count, v3Digest, v3Get, v3List, v3Load, v3ProposeChanges,
  v3ReviewIngestion, v3Search, v3Share,
} from "./v3.ts";
import { ADMIN_ACTIONS, v3Admin } from "./v3_admin.ts";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

function guarded(fn: (args: Record<string, unknown>) => Promise<unknown>) {
  return async (args: Record<string, unknown>) => {
    try {
      return json(await fn(args));
    } catch (e) {
      if (e instanceof AccessError) return { content: [{ type: "text" as const, text: `Access denied: ${e.message}` }], isError: true };
      console.error("[mcp v3] verb failed:", e);
      return { content: [{ type: "text" as const, text: `Error: ${safeErrorMessage(e)}` }], isError: true };
    }
  };
}

export function buildV3Server(sub: string): McpServer {
  const server = new McpServer({ name: "memento-v3", title: "Memento", version: "3.0.0" }, { instructions: V3_INSTRUCTIONS });
  const changeSchema = z.array(z.object({ op: z.string(), payload: z.record(z.string(), z.any()) })).max(500);

  server.registerTool("load", {
    description: "APPELLE-MOI EN PREMIER dès qu'il s'agit de mémoriser ou retrouver une info : l'épine d'une base — guide (doctrine racine) + arbre N+2 + entités saillantes + compteurs + etag. 0 LLM. Permet de te repérer avant toute recherche.",
    inputSchema: { base: z.string().optional(), depth: z.number().int().min(1).max(4).optional() },
    // deno-lint-ignore no-explicit-any
  }, guarded((a) => v3Load(sub, a as any)));

  server.registerTool("search", {
    description: "Recherche hybride pgvector(chunks)+FTS(pages) en RRF → page + passage. scope savoir|sources|both.",
    inputSchema: {
      q: z.string(), scope: z.enum(["savoir", "sources", "both"]).optional(),
      filters: z.record(z.string(), z.any()).optional(), limit: z.number().int().min(1).max(50).optional(),
    },
    // deno-lint-ignore no-explicit-any
  }, guarded((a) => v3Search(sub, a as any)));

  server.registerTool("get", {
    description: "Détail d'une page ou d'une entité (+ navigation locale : children|backlinks|sources|grants). `grants` = liste « Qui a accès » (réservée à qui peut gérer la page ; sinon null).",
    inputSchema: { id: z.string(), kind: z.enum(["page", "entity"]), include: z.array(z.enum(["children", "backlinks", "sources", "grants"])).optional() },
    // deno-lint-ignore no-explicit-any
  }, guarded((a) => v3Get(sub, a as any)));

  server.registerTool("list", {
    description: "Énumération déterministe (100% recall) sous accès. kind pages|entities|sources|ingestions|entity_review. `totalCount` = vrai total ; pagine au-delà de `limit` en repassant le `cursor` renvoyé.",
    inputSchema: { kind: z.enum(LIST_KINDS), base: z.string().optional(), filters: z.record(z.string(), z.any()).optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    // deno-lint-ignore no-explicit-any
  }, guarded((a) => v3List(sub, a as any)));

  server.registerTool("count", {
    description: "Compte déterministe — mêmes filtres que list.",
    inputSchema: { kind: z.enum(LIST_KINDS), base: z.string().optional(), filters: z.record(z.string(), z.any()).optional() },
    // deno-lint-ignore no-explicit-any
  }, guarded((a) => v3Count(sub, a as any)));

  server.registerTool("propose_changes", {
    description: "Propose un change-set (NE MUTE RIEN) → crée une ingestion + renvoie similar_existing. Gère toutes les ProposeOp (create_page, update_page, assert_entity…).",
    inputSchema: { title: z.string(), base: z.string().optional(), changes: changeSchema, clientKey: z.string().optional() },
    // deno-lint-ignore no-explicit-any
  }, guarded((a) => v3ProposeChanges(sub, a as any)));

  server.registerTool("apply", {
    description: "Applique une ingestion (idempotent, lock CAS). Écrit les pages puis déclenche l'extraction NER en async.",
    inputSchema: { ingestionId: z.string() },
    // deno-lint-ignore no-explicit-any
  }, guarded((a) => v3Apply(sub, a as any)));

  server.registerTool("digest", {
    description: "Delta déterministe de la base sur N jours (pages & décisions récentes, décisions ouvertes, révisions). 0 résumé serveur — l'agent habille.",
    inputSchema: { base: z.string().optional(), sinceDays: z.number().int().min(1).max(90).optional() },
    // deno-lint-ignore no-explicit-any
  }, guarded((a) => v3Digest(sub, a as any)));

  server.registerTool("review_ingestion", {
    description: "Décision de Revue sur une proposition (Pages) : reject ou send_back (renvoi à l'agent + note). L'accept = apply.",
    inputSchema: { ingestionId: z.string(), decision: z.enum(["reject", "send_back"]), reviewNote: z.string().optional() },
    // deno-lint-ignore no-explicit-any
  }, guarded((a) => v3ReviewIngestion(sub, a as any)));

  server.registerTool("share", {
    description: "Partage par page : visibilité (private|org|public) OU grant user (read|write, ou none pour RÉVOQUER). `user` accepte un email (le compte est provisionné + invité au besoin, sauf en révocation) ou un sub. Renvoie `resolved` (email→sub, pending, provisioned).",
    inputSchema: {
      pageRef: z.string(),
      to: z.union([z.object({ visibility: z.enum(["private", "org", "public"]) }), z.object({ user: z.string(), mode: z.enum(["read", "write", "none"]) })]),
    },
    // deno-lint-ignore no-explicit-any
  }, guarded((a) => v3Share(sub, a as any)));

  // admin = verbe UNIQUE hors noyau (gestion org/équipe). 1 org = 1 base → create_org
  // crée la base d'office, rename_base la renomme. Rôles admin|member. Champs lus selon l'action.
  server.registerTool("admin", {
    description: "Gestion org/équipe : action=orgs (lister mes orgs + membres + base), create_org (crée org + sa base), rename_base, invite_member (par email), set_role (admin|member), remove_member.",
    inputSchema: {
      action: z.enum(ADMIN_ACTIONS),
      name: z.string().optional(), slug: z.string().optional(), baseName: z.string().optional(),
      baseId: z.string().optional(), orgSlug: z.string().optional(),
      email: z.string().optional(), userId: z.string().optional(), role: z.enum(["admin", "member"]).optional(),
    },
    // deno-lint-ignore no-explicit-any
  }, guarded((a) => v3Admin(sub, a as any)));

  return server;
}

export async function handleV3Request(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/health")) return new Response("ok");
  const disc = isDiscoveryPath(url.pathname);
  if (disc === "prm") return new Response(JSON.stringify(protectedResourceMetadata()), { headers: { "content-type": "application/json" } });
  if (disc === "as") return authServerMetadata();

  const auth = await authenticate(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.message }), {
      status: auth.status, headers: { "content-type": "application/json", "www-authenticate": wwwAuthenticate() },
    });
  }
  if (url.pathname.endsWith("/mcp") || url.pathname === "/") {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await buildV3Server(auth.claims.sub ?? "").connect(transport);
    return transport.handleRequest(req);
  }
  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000) }, handleV3Request);
}
