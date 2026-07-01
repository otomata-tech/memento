// /api/* → function api Supabase (miroir REST lecture du viewer).
import { proxyTo } from "../_proxy";

type Ctx = { request: Request; env: { SUPABASE_URL: string } };
export const onRequest = (ctx: Ctx): Promise<Response> => {
  const { pathname } = new URL(ctx.request.url); // ex. /api/v3/get
  // v3 : /api/v3/<verb> → function api-v3 (elle dérive le verbe du dernier segment).
  return proxyTo(ctx.env.SUPABASE_URL, "/functions/v1/api-v3" + pathname.replace(/^\/api/, ""), ctx.request, true);
};
