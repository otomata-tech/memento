// /api/* → function api Supabase (miroir REST lecture du viewer).
import { proxyTo } from "../_proxy";

type Ctx = { request: Request; env: { SUPABASE_URL: string } };
export const onRequest = (ctx: Ctx): Promise<Response> => {
  const { pathname } = new URL(ctx.request.url); // ex. /api/workspaces
  return proxyTo(ctx.env.SUPABASE_URL, "/functions/v1" + pathname, ctx.request, true);
};
