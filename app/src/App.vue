<script setup lang="ts">
import { onMounted } from "vue";
import Toaster from "./components/Toaster.vue";
import ConsentBanner from "./components/ConsentBanner.vue";
import { startRealtime } from "./lib/realtime";

// Live inbox: subscribe once at the root to the realtime "inbox changed" pings.
onMounted(startRealtime);
</script>

<template>
  <router-view />
  <Toaster />
  <ConsentBanner />
</template>
