// /.well-known/* → function mcp (discovery OAuth : PRM RFC 9728 + AS metadata).
import { proxyTo } from "../_proxy";

type Ctx = { request: Request; env: { SUPABASE_URL: string } };
export const onRequest = (ctx: Ctx): Promise<Response> => {
  const { pathname } = new URL(ctx.request.url); // ex. /.well-known/oauth-protected-resource
  return proxyTo(ctx.env.SUPABASE_URL, "/functions/v1/mcp" + pathname, ctx.request, true);
};
