// /mcp → function mcp Supabase. Query droppée (mirror Caddy `rewrite * /functions/v1/mcp`).
import { proxyTo } from "./_proxy";

type Ctx = { request: Request; env: { SUPABASE_URL: string } };
export const onRequest = (ctx: Ctx): Promise<Response> =>
  proxyTo(ctx.env.SUPABASE_URL, "/functions/v1/mcp", ctx.request, false);
