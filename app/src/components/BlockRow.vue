<script setup lang="ts">
// A typed block in the Reader column: the text (md) in the reading column,
// the metadata (badge, id, trust mark) in the left side margin;
// sources, typed-link chips and comments as a note below the text.
// Click → focuses the dossier.
import type { Block } from "../api";
import { roleClass, trustMark, renderMd, safeHref, RELLABEL, RELGLYPH, relClass } from "../lib/blocks";

const props = defineProps<{ block: Block; focused?: boolean; deprecated?: boolean }>();
const emit = defineEmits<{ (e: "select"): void; (e: "graph", blockId: string): void }>();

const mark = () => trustMark(props.block);
</script>

<template>
  <div class="block" :class="[roleClass(block.type), { on: focused, deprecated }]" @click="emit('select')">
    <div class="bmeta">
      <span class="badge">{{ block.type }}</span>
      <span class="gx">{{ block.id.slice(0, 8) }}</span>
      <span v-if="deprecated" class="gx" style="text-transform:uppercase;border:1px solid var(--color-hair);padding:0 4px">deprecated</span>
      <span class="vmark" :class="mark()[0]">{{ mark()[1] }}</span>
    </div>
    <div class="bbody">
      <div class="btext" v-html="renderMd(block.content)" />

      <div v-if="block.sources.length" class="sources">
        <span class="src">
          <a v-if="safeHref(block.sources[0].ref) || safeHref(block.sources[0].locator)" :href="safeHref(block.sources[0].ref) || safeHref(block.sources[0].locator)" target="_blank" rel="noopener" @click.stop>{{ block.sources[0].title }}</a>
          <template v-else>{{ block.sources[0].title }}</template>
          <span v-if="block.sources[0].citation"> — {{ block.sources[0].citation }}</span>
          <span v-if="block.sources.length > 1"> · +{{ block.sources.length - 1 }}</span>
        </span>
      </div>

      <div v-if="block.linksFrom.length || block.linksTo.length || block.comments.length" class="rels">
        <span v-for="l in block.linksFrom" :key="l.id" class="rel" :class="relClass(l.relation)"
          :title="l.note || ''" @click.stop="emit('graph', l.toBlockId!)">
          {{ RELGLYPH[l.relation] }} {{ RELLABEL[l.relation] }} {{ l.toBlockId?.slice(0, 8) }}
        </span>
        <span v-for="l in block.linksTo" :key="l.id" class="rel" :class="relClass(l.relation)"
          :title="l.note || ''" @click.stop="emit('graph', l.fromBlockId!)">
          {{ l.fromBlockId?.slice(0, 8) }} {{ RELLABEL[l.relation] }} {{ RELGLYPH[l.relation] }}
        </span>
        <span v-for="c in block.comments" :key="c.id" class="cmt">
          {{ c.authorKind === "agent" ? "🤖" : "🧑" }} {{ c.body }}<span v-if="c.resolvedAt"> · resolved</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Long unbroken strings (gsheets URLs, slugs…) must wrap, not overflow the column. */
.btext { overflow-wrap: anywhere; }
.btext :deep(a) { overflow-wrap: anywhere; word-break: break-word; }
.btext :deep(pre) { overflow-x: auto; max-width: 100%; }
.src, .src a { overflow-wrap: anywhere; word-break: break-word; }
</style>
