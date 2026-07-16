/**
 * Entrée Supabase Edge de la surface MCP (page-centrée). Mince enveloppe :
 * tout vit dans mcp/v3_server.ts (transport) + mcp/v3.ts (logique).
 * Fonction déployée sous le slug `mcp` (proxifiée par mcp.mento.cc/mcp).
 */
import { handleV3Request } from "./v3_server.ts";

Deno.serve(handleV3Request);
