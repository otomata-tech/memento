<script setup lang="ts">
import Toaster from "./components/Toaster.vue";
import ConsentBanner from "./components/ConsentBanner.vue";
</script>

<template>
  <router-view />
  <Toaster />
  <ConsentBanner />
</template>
