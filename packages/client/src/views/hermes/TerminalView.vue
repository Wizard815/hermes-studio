<script setup lang="ts">
// The full-page terminal (/hermes/terminal) is the chat drawer's terminal at full
// size: one client for the terminal socket, so restore, reconnect and input
// handling are the same in both places.
import TerminalPanel from "@/components/hermes/chat/TerminalPanel.vue";
</script>

<template>
  <div class="terminal-page">
    <TerminalPanel visible />
  </div>
</template>

<style scoped lang="scss">
.terminal-page {
  height: 100%;
  width: 100%;
  min-height: 0;
  display: flex;
}
</style>
