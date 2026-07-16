// /api/* → function api Supabase (miroir REST lecture du viewer).
import { proxyTo } from "../_proxy";

type Ctx = { request: Request; env: { SUPABASE_URL: string } };
export const onRequest = (ctx: Ctx): Promise<Response> => {
  const { pathname } = new URL(ctx.request.url); // ex. /api/get
  // /api/<verb> → function `api` (elle dérive le verbe du dernier segment du pathname).
  return proxyTo(ctx.env.SUPABASE_URL, "/functions/v1/api" + pathname.replace(/^\/api/, ""), ctx.request, true);
};
