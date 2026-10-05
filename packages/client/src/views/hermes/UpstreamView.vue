<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import PageHeader from '@/components/layout/PageHeader.vue'

const { t } = useI18n()

// Upstream Management app served by Studio's own /upstream proxy so it lives on
// the same origin/port as Studio (#/hermes/upstream) instead of a separate localhost:5001. It renders in a full-frame iframe.
const UPSTREAM_PATH = import.meta.env.VITE_UPSTREAM_PATH || '/upstream'
const loaded = ref(false)
const frameError = ref(false)
</script>

<template>
  <div class="upstream-view">
    <PageHeader>
      <header class="page-header">
        <h2 class="header-title">{{ t('sidebar.upstream') }}</h2>
      </header>
    </PageHeader>

    <div class="upstream-frame-wrap">
      <iframe
        :src="UPSTREAM_PATH"
        class="upstream-frame"
        title="Upstream Management"
        loading="lazy"
        @load="loaded = true"
        @error="frameError = true"
      />
      <div v-if="frameError" class="upstream-frame-fallback">
        <p>Unable to load Upstream Management.</p>
        <p class="muted">Make sure it is reachable and Studio's /upstream proxy is enabled.</p>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.upstream-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: $bg-main-surface;
}

.upstream-frame-wrap {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}

.upstream-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: #0f1115;
}

.upstream-frame-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  text-align: center;
  padding: 24px;
  color: $text-secondary;
  background: $bg-main-surface;
}
</style>
