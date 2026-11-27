<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NPopconfirm, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchSandboxes, removeSandbox, type SandboxSummary } from '@/api/studio/sandbox'

/** Sandboxes agents made (docs/sandbox.md), with Remove. Lives on the Test Lab page. */

const { t } = useI18n()
const toast = useMessage()
const sandboxes = ref<SandboxSummary[]>([])
const loadError = ref('')
const busy = ref('')
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  try {
    sandboxes.value = (await fetchSandboxes()).sandboxes
    loadError.value = ''
  } catch (error) { loadError.value = (error as Error).message }
}

async function remove(id: string) {
  busy.value = id
  try {
    await removeSandbox(id)
    toast.success(t('sandbox.removed'))
    await load()
  } catch (error) { toast.error(t('sandbox.removeFailed', { error: (error as Error).message })) } finally { busy.value = '' }
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

onMounted(() => { void load(); timer = setInterval(() => { void load() }, 15000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section class="sandbox-card" data-theme-surface="card" data-testid="sandbox-card">
    <div class="sandbox-head">
      <h3>{{ t('sandbox.title') }}</h3>
      <NButton size="small" secondary @click="load">{{ t('sandbox.refresh') }}</NButton>
    </div>
    <p class="lab-muted">{{ t('sandbox.intro') }}</p>
    <p v-if="loadError" class="lab-error" role="alert">{{ t('sandbox.loadFailed', { error: loadError }) }}</p>
    <p v-else-if="!sandboxes.length" class="lab-muted" role="status">{{ t('sandbox.empty') }}</p>
    <ul v-else class="lab-list" aria-live="polite">
      <li v-for="box in sandboxes" :key="box.id" class="sandbox-item" data-testid="sandbox-item">
        <div class="sandbox-main">
          <code>{{ box.image }}</code>
          <span class="lab-badge" :data-state="box.state">{{ box.state }}</span>
          <span class="lab-badge">{{ box.network === 'none' ? t('sandbox.offline') : t('sandbox.internet') }}</span>
          <span class="lab-muted">{{ t('sandbox.expires', { time: time(box.expiresAt) }) }}</span>
        </div>
        <span v-if="box.purpose" class="lab-muted">{{ box.purpose }}</span>
        <span v-if="box.repos.length" class="lab-muted">{{ box.repos.join(', ') }}</span>
        <NPopconfirm @positive-click="remove(box.id)">
          <template #trigger>
            <NButton size="small" secondary :loading="busy === box.id" :aria-label="`${t('sandbox.remove')} ${box.image}`" data-testid="sandbox-remove">{{ t('sandbox.remove') }}</NButton>
          </template>
          {{ t('sandbox.removeConfirm') }}
        </NPopconfirm>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.sandbox-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  overflow-wrap: anywhere;
}
.sandbox-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.sandbox-head h3 { margin: 0; }
.lab-muted { margin: 0; font-size: 12px; color: $text-muted; overflow-wrap: anywhere; }
.lab-error { margin: 0; color: $error; }
.lab-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.sandbox-item { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; align-items: flex-start; border-top: var(--border-width, 1px) solid $border-light; }
.sandbox-main { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.lab-badge {
  padding: 0 6px;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  color: $text-secondary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 9px;
  &[data-state="running"] { color: $accent-primary; }
  &[data-state="exited"], &[data-state="gone"] { color: $warning; }
}
</style>
