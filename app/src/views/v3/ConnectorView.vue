<script setup lang="ts">
/**
 * Memento V3 — page « Connecteur » : montre EXACTEMENT ce que l'agent (Claude) reçoit
 * du serveur MCP, interrogé EN DIRECT sur le même endpoint `/mcp` que claude.ai.
 * Zéro drift par construction : on n'affiche pas une copie du code, on rend la réponse
 * de `initialize` (instructions serveur) + `tools/list` (outils + schémas).
 */
import { onMounted, ref } from "vue";
import { supabase } from "../../auth";

interface ToolDef {
  name: string;
  description: string;
  inputSchema?: { properties?: Record<string, SchemaProp>; required?: string[] };
}
interface SchemaProp { type?: string; enum?: unknown[]; minimum?: number; maximum?: number; description?: string }

const loading = ref(true);
const error = ref("");
const instructions = ref("");
const server = ref<{ name?: string; title?: string; version?: string }>({});
const protocol = ref("");
const tools = ref<ToolDef[]>([]);

/** Un appel JSON-RPC sur l'endpoint MCP. Réponse en SSE (event: message / data: {json}). */
async function callMcp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session?.access_token ?? ""}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  if (!line) throw new Error(`réponse MCP inattendue (${res.status})`);
  const msg = JSON.parse(line.slice(5).trim());
  if (msg.error) throw new Error(msg.error.message ?? "erreur MCP");
  return msg.result;
}

function params(t: ToolDef): { name: string; type: string; required: boolean; enum?: string }[] {
  const props = t.inputSchema?.properties ?? {};
  const req = new Set(t.inputSchema?.required ?? []);
  return Object.entries(props).map(([name, p]) => ({
    name,
    type: p.type ?? "any",
    required: req.has(name),
    enum: p.enum ? p.enum.join(" | ") : undefined,
  }));
}

onMounted(async () => {
  try {
    const init = await callMcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "memento-viewer", version: "3" },
    });
    instructions.value = init.instructions ?? "";
    server.value = init.serverInfo ?? {};
    protocol.value = init.protocolVersion ?? "";
    const tl = await callMcp("tools/list");
    tools.value = (tl.tools ?? []) as ToolDef[];
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="connector">
    <header class="head">
      <h1>Connecteur</h1>
      <p class="sub">
        Ce que <strong>Claude reçoit</strong> du serveur Memento, interrogé en direct sur l'endpoint
        <code>/mcp</code> — pas une copie, la réponse réelle.
      </p>
    </header>

    <p v-if="loading" class="muted">Interrogation du connecteur…</p>
    <p v-else-if="error" class="error">Erreur : {{ error }}</p>

    <template v-else>
      <div class="meta">
        <span><b>{{ server.title || server.name }}</b> v{{ server.version }}</span>
        <span class="dot">·</span>
        <span>protocole MCP {{ protocol }}</span>
        <span class="dot">·</span>
        <span>{{ tools.length }} outils</span>
      </div>

      <section class="block">
        <h2>Instructions serveur</h2>
        <p class="hint">Préambule injecté à chaque connexion — oriente l'agent vers Memento.</p>
        <blockquote class="instr">{{ instructions }}</blockquote>
      </section>

      <section class="block">
        <h2>Outils</h2>
        <p class="hint">Les verbes exposés à l'agent, avec leur description et leurs paramètres exacts.</p>
        <ul class="tools">
          <li v-for="t in tools" :key="t.name" class="tool">
            <code class="tname">{{ t.name }}</code>
            <p class="tdesc">{{ t.description }}</p>
            <div v-if="params(t).length" class="tparams">
              <span v-for="p in params(t)" :key="p.name" class="param" :class="{ req: p.required }">
                {{ p.name }}<span class="ptype">: {{ p.enum || p.type }}</span><span v-if="p.required" class="star">*</span>
              </span>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.connector { max-width: 820px; }
.head h1 { font-family: var(--font-display, serif); font-size: 1.5rem; margin: 0 0 0.3rem; }
.sub { color: var(--color-mute, #6b6b6b); margin: 0 0 1.2rem; font-size: 0.9rem; }
.sub code { font-family: var(--font-mono, monospace); font-size: 0.85em; background: var(--color-bg, #f3f1ec); padding: 1px 5px; border-radius: 3px; }
.muted { color: var(--color-mute, #6b6b6b); }
.error { color: #b00020; }
.meta { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; color: var(--color-mute, #6b6b6b); margin-bottom: 1.5rem; }
.meta .dot { opacity: 0.5; }
.block { margin-bottom: 2rem; }
.block h2 { font-family: var(--font-display, serif); font-size: 1.1rem; margin: 0 0 0.2rem; }
.hint { color: var(--color-mute, #6b6b6b); font-size: 0.82rem; margin: 0 0 0.7rem; }
.instr {
  margin: 0; padding: 0.9rem 1.1rem; border-left: 3px solid var(--color-primary, #b5532a);
  background: var(--color-surface, #fff); color: var(--color-ink, #1a1a1a);
  font-size: 0.9rem; line-height: 1.55;
}
.tools { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.85rem; }
.tool { border: 1px solid var(--color-hair, #e5e2dc); border-radius: 6px; padding: 0.7rem 0.9rem; background: var(--color-surface, #fff); }
.tname { font-family: var(--font-mono, monospace); font-weight: 700; color: var(--color-primary, #b5532a); font-size: 0.92rem; }
.tdesc { margin: 0.35rem 0 0; font-size: 0.86rem; line-height: 1.45; color: var(--color-ink, #1a1a1a); }
.tparams { margin-top: 0.55rem; display: flex; flex-wrap: wrap; gap: 0.4rem; }
.param { font-family: var(--font-mono, monospace); font-size: 0.74rem; padding: 2px 7px; border-radius: 4px; background: var(--color-bg, #f3f1ec); color: var(--color-mute, #555); }
.param.req { background: color-mix(in srgb, var(--color-primary, #b5532a) 10%, transparent); color: var(--color-ink, #1a1a1a); }
.param .ptype { opacity: 0.7; }
.param .star { color: var(--color-primary, #b5532a); margin-left: 1px; }
</style>
