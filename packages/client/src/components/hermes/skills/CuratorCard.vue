<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getCurator, runCurator, setCuratorPaused, waitForAction, type CuratorStatus } from '@/api/hermes/agent-memory'

const emit = defineEmits<{ ran: [] }>()
const { t } = useI18n()
const message = useMessage()

const status = ref<CuratorStatus | null>(null)
const loading = ref(false)
const busy = ref<'' | 'pause' | 'run'>('')

const state = computed(() => !status.value ? null : !status.value.enabled ? 'off' : status.value.paused ? 'paused' : 'active')
const lastRun = computed(() => {
  const at = status.value?.last_run_at
  if (!at) return t('hermesMemory.never')
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
})

function errorText(err: any): string {
  return String(err?.message || err || '').replace(/^API Error \d+:\s*/, '') || t('hermesMemory.actionFailed')
}

async function load() {
  loading.value = true
  try {
    status.value = await getCurator()
  } catch (err) {
    message.error(errorText(err))
  } finally {
    loading.value = false
  }
}

async function togglePause() {
  if (!status.value) return
  busy.value = 'pause'
  try {
    const res = await setCuratorPaused(!status.value.paused)
    status.value = { ...status.value, paused: res.paused }
  } catch (err) {
    message.error(errorText(err))
  } finally {
    busy.value = ''
  }
}

async function runNow() {
  busy.value = 'run'
  try {
    const action = await runCurator()
    message.info(t('hermesMemory.runStarted'))
    const result = await waitForAction(action.name, { intervalMs: 3000, timeoutMs: 600_000 })
    if (result.exit_code && result.exit_code !== 0) message.error(result.lines.slice(-3).join('\n') || t('hermesMemory.actionFailed'))
    await load()
    emit('ran')
  } catch (err) {
    message.error(errorText(err))
  } finally {
    busy.value = ''
  }
}

onMounted(load)
</script>

<template>
  <div class="curator-card">
    <div class="curator-head">
      <span class="curator-title">{{ t('hermesMemory.curator') }}</span>
      <NTag v-if="state" size="small" round :bordered="false" :type="state === 'active' ? 'success' : state === 'paused' ? 'warning' : 'default'">
        {{ state === 'active' ? t('hermesMemory.curatorActive') : state === 'paused' ? t('hermesMemory.curatorPaused') : t('hermesMemory.curatorOff') }}
      </NTag>
    </div>
    <p class="curator-desc">{{ t('hermesMemory.curatorDesc') }}</p>
    <NSpin :show="loading && !status" size="small">
      <dl v-if="status" class="curator-facts">
        <template v-if="status.interval_hours">
          <dt>{{ t('hermesMemory.every', { n: status.interval_hours }) }}</dt><dd></dd>
        </template>
        <dt>{{ t('hermesMemory.lastRun') }}</dt><dd>{{ lastRun }}</dd>
        <template v-if="status.stale_after_days">
          <dt>{{ t('hermesMemory.staleAfter', { n: status.stale_after_days }) }}</dt><dd></dd>
        </template>
        <template v-if="status.archive_after_days">
          <dt>{{ t('hermesMemory.archiveAfter', { n: status.archive_after_days }) }}</dt><dd></dd>
        </template>
      </dl>
    </NSpin>
    <div class="curator-actions">
      <NButton size="small" :disabled="!status || !status.enabled || !!busy" :loading="busy === 'pause'" @click="togglePause">
        {{ status?.paused ? t('hermesMemory.resume') : t('hermesMemory.pause') }}
      </NButton>
      <NButton size="small" type="primary" :disabled="!status || !!busy" :loading="busy === 'run'" @click="runNow">
        {{ t('hermesMemory.runNow') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.curator-card {
  width: 280px;
  max-width: calc(100vw - 48px);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.curator-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.curator-title {
  font-weight: 600;
  color: $text-primary;
}

.curator-desc {
  margin: 0;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
}

.curator-facts {
  margin: 0;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 12px;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);

  dt {
    color: $text-secondary;
  }

  dd {
    margin: 0;
    color: $text-primary;
    text-align: end;
  }
}

.curator-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
