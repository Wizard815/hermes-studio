<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { saveHermesToolSearch } from '@/api/studio/tool-load'
import { useToolLoadStore } from '@/stores/hermes/tool-load'

/**
 * Too many tools for a small model (docs/hermes-tool-load.md): once per Hermes
 * chat, how many tools it has and three ways out: turn off tool search for the
 * chat's profile, switch off MCP servers, or open the Tools settings.
 */
const props = defineProps<{ sessionId: string }>()
const { t } = useI18n()
const toast = useMessage()
const router = useRouter()
const store = useToolLoadStore()
const busy = ref<'' | 'search' | 'dismiss'>('')

watch(() => props.sessionId, id => { if (id) void store.load(id) }, { immediate: true })

const notice = computed(() => store.active(props.sessionId))
const canTurnOff = computed(() => !!notice.value && notice.value.toolSearch !== 'off')

async function turnOffToolSearch() {
  const current = notice.value
  if (!current || busy.value) return
  busy.value = 'search'
  try {
    await saveHermesToolSearch('off', current.profile)
    store.set(props.sessionId, { ...current, toolSearch: 'off' })
    toast.success(t('toolLoad.searchTurnedOff', { profile: current.profile }))
  } catch (error: any) {
    toast.error(error?.message || t('toolLoad.failed'))
  } finally {
    busy.value = ''
  }
}

async function dismiss() {
  if (busy.value) return
  busy.value = 'dismiss'
  try { await store.dismiss(props.sessionId) } catch { /* hidden here already */ } finally { busy.value = '' }
}

const openMcp = () => router.push({ name: 'hermes.mcp' })
const openSettings = () => router.push({ name: 'hermes.configSettings', query: { tab: 'tools' } })
</script>

<template>
  <div v-if="notice" class="tool-load-banner" data-theme-surface="card" role="status" aria-live="polite" data-testid="tool-load-banner">
    <div class="tool-load-banner__text">
      <div class="tool-load-banner__title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
        </svg>
        <span>{{ t('toolLoad.title') }}</span>
      </div>
      <p class="tool-load-banner__sentence">{{ t('toolLoad.sentence', { count: notice.total }) }}</p>
      <p v-if="notice.toolSearchActive" class="tool-load-banner__note">{{ t('toolLoad.deferred', { count: notice.deferred }) }}</p>
      <p class="tool-load-banner__note">{{ t('toolLoad.advice', { profile: notice.profile }) }}</p>
      <p v-if="!canTurnOff" class="tool-load-banner__note">{{ t('toolLoad.searchIsOff') }}</p>
    </div>
    <div class="tool-load-banner__actions">
      <NButton v-if="canTurnOff" size="small" type="primary" :loading="busy === 'search'" :disabled="!!busy" data-testid="tool-load-search-off" @click="turnOffToolSearch">
        {{ t('toolLoad.turnOffSearch') }}
      </NButton>
      <NButton size="small" secondary :disabled="!!busy" data-testid="tool-load-mcp" @click="openMcp">
        {{ t('toolLoad.mcpServers') }}
      </NButton>
      <NButton size="small" secondary :disabled="!!busy" data-testid="tool-load-settings" @click="openSettings">
        {{ t('toolLoad.settings') }}
      </NButton>
      <NButton size="small" quaternary :loading="busy === 'dismiss'" :disabled="!!busy" data-testid="tool-load-dismiss" @click="dismiss">
        {{ t('toolLoad.dismiss') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.tool-load-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 auto 8px;
  width: min(860px, calc(100% - 32px));
  padding: 10px 14px;
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $info;
  border-radius: var(--radius-component, 8px);
}

.tool-load-banner__text {
  flex: 1;
  min-width: 0;
}

.tool-load-banner__title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: $info;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.tool-load-banner__sentence {
  margin: 4px 0 0;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
}

.tool-load-banner__note {
  margin: 4px 0 0;
  color: $text-secondary;
  font-size: 12px;
}

.tool-load-banner__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  max-width: 50%;
}

@media (max-width: 640px) {
  .tool-load-banner {
    flex-direction: column;
    align-items: stretch;
  }

  .tool-load-banner__actions {
    justify-content: flex-start;
    max-width: none;
  }
}
</style>
