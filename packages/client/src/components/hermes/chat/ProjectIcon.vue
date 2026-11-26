<script setup lang="ts">
// The Projects mark (a folder with a plus), used wherever a chat or folder belongs to a project.
withDefaults(defineProps<{ size?: number }>(), { size: 13 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M8 13h8M12 9v8" />
  </svg>
</template>
