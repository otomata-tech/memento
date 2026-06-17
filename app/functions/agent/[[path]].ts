// /agent/* → function agent Supabase (mode agent : chat SSE sur une KB publique).
// Miroir de /api : le corps (POST) et la réponse (SSE) sont streamés tels quels.
import { proxyTo } from "../_proxy";

type Ctx = { request: Request; env: { SUPABASE_URL: string } };
export const onRequest = (ctx: Ctx): Promise<Response> => {
  const { pathname } = new URL(ctx.request.url); // ex. /agent/chat
  return proxyTo(ctx.env.SUPABASE_URL, "/functions/v1" + pathname, ctx.request, true);
};
