/**
 * Entrée Supabase Edge de la surface MCP v3 (page-centrée) — déployée sur le projet
 * BLUE-GREEN `memento-v3`. Mince enveloppe : tout vit dans mcp/v3_server.ts (transport)
 * + mcp/v3.ts (logique). Au cutover, l'entrée v2 (mcp/index.ts) pointera ici.
 */
import { handleV3Request } from "../mcp/v3_server.ts";

Deno.serve(handleV3Request);
