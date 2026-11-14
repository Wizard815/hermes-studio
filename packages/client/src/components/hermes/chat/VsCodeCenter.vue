<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { closeVsCodeSession, getVsCodeStatus, installVsCode, openVsCodeSession, vscodeUrl, type VsCodeStatus } from '@/api/studio/vscode'

/**
 * VS Code (code-server, run by Studio) on the chat's folder. The chat stays
 * beside it. Studio's "Follow agent edits" extension opens files as the agent
 * changes them.
 */
const props = defineProps<{ folder: string | null; active: boolean }>()
const { t } = useI18n()

const status = ref<VsCodeStatus | null>(null)
const session = ref<{ id: string; path: string } | null>(null)
const phase = ref<'loading' | 'missing' | 'installing' | 'starting' | 'ready' | 'failed'>('loading')
const failure = ref('')
const frameKey = ref(0)
let poll: ReturnType<typeof setTimeout> | null = null

const src = computed(() => session.value ? vscodeUrl(session.value.path, props.folder) : '')
const folderName = computed(() => props.folder?.split(/[\\/]/).filter(Boolean).pop() || '')

function errorText(error: unknown): string {
  return (error as any)?.data?.error || (error as any)?.message || String(error)
}

async function refresh() {
  try {
    status.value = await getVsCodeStatus()
  } catch (error) {
    phase.value = 'failed'
    failure.value = errorText(error)
    return
  }
  if (status.value.installing) {
    phase.value = 'installing'
    poll = setTimeout(() => void refresh(), 2000)
    return
  }
  if (!status.value.available) {
    phase.value = status.value.error ? 'failed' : 'missing'
    failure.value = status.value.error || ''
    return
  }
  await start()
}

async function start() {
  if (session.value) { phase.value = 'ready'; return }
  phase.value = 'starting'
  try {
    session.value = await openVsCodeSession()
    phase.value = 'ready'
  } catch (error) {
    phase.value = 'failed'
    failure.value = errorText(error)
  }
}

async function install() {
  failure.value = ''
  try {
    status.value = await installVsCode()
    phase.value = 'installing'
    poll = setTimeout(() => void refresh(), 2000)
  } catch (error) {
    phase.value = 'failed'
    failure.value = errorText(error)
  }
}

function retry() {
  failure.value = ''
  phase.value = 'loading'
  void refresh()
}

function reload() { frameKey.value += 1 }

// Opened the first time the Code view is shown, then kept so swapping back is instant.
watch(() => props.active, (active) => { if (active && phase.value === 'loading' && !poll) void refresh() }, { immediate: true })

onBeforeUnmount(() => {
  if (poll) clearTimeout(poll)
  if (session.value) void closeVsCodeSession(session.value.id).catch(() => undefined)
})
</script>

<template>
  <div class="vscode-center" data-testid="vscode-center">
    <div class="vscode-bar">
      <span class="vscode-title">{{ t('vscode.title') }}</span>
      <span v-if="folderName" class="vscode-folder" :title="folder || ''">{{ folderName }}</span>
      <span v-else-if="phase === 'ready'" class="vscode-folder muted">{{ t('vscode.noFolder') }}</span>
      <span class="vscode-spacer" />
      <template v-if="phase === 'ready'">
        <button type="button" class="vscode-link" data-testid="vscode-reload" @click="reload">{{ t('vscode.reload') }}</button>
        <a class="vscode-link" :href="src" target="_blank" rel="noopener">{{ t('vscode.openInTab') }}</a>
      </template>
    </div>
    <iframe
      v-if="phase === 'ready' && src"
      :key="frameKey"
      class="vscode-frame"
      :src="src"
      :title="t('vscode.title')"
      allow="clipboard-read; clipboard-write"
      data-testid="vscode-frame"
    />
    <div v-else class="vscode-state">
      <template v-if="phase === 'missing'">
        <p class="vscode-headline">{{ t('vscode.notInstalled') }}</p>
        <p class="vscode-hint">{{ status?.problem || t('vscode.installHint') }}</p>
        <NButton type="primary" :disabled="!!status?.problem" data-testid="vscode-install" @click="install">{{ t('vscode.install') }}</NButton>
      </template>
      <template v-else-if="phase === 'installing'">
        <p class="vscode-headline">{{ t('vscode.installing') }}</p>
        <pre v-if="status?.log?.length" class="vscode-log">{{ status.log.slice(-8).join('\n') }}</pre>
      </template>
      <template v-else-if="phase === 'failed'">
        <p class="vscode-headline">{{ status?.available ? t('vscode.startFailed') : t('vscode.installFailed') }}</p>
        <p class="vscode-hint">{{ failure }}</p>
        <pre v-if="status?.log?.length" class="vscode-log">{{ status.log.slice(-8).join('\n') }}</pre>
        <NButton @click="retry">{{ t('vscode.retry') }}</NButton>
      </template>
      <p v-else class="vscode-hint">{{ t('vscode.starting') }}</p>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.vscode-center {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  border-right: var(--border-width, 1px) solid $border-light;
}

.vscode-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  font-size: 12px;
  border-bottom: var(--border-width, 1px) solid $border-light;
  min-height: 28px;
}

.vscode-title { font-weight: 600; }
.vscode-folder { opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vscode-folder.muted { opacity: 0.55; }
.vscode-spacer { flex: 1; }

.vscode-link {
  background: none;
  border: 0;
  padding: 0;
  color: inherit;
  opacity: 0.75;
  cursor: pointer;
  font: inherit;
  text-decoration: none;

  &:hover { opacity: 1; text-decoration: underline; }
}

.vscode-frame {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 0;
  background: #1e1e1e;
}

.vscode-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
}

.vscode-headline { font-size: 15px; font-weight: 600; margin: 0; }
.vscode-hint { max-width: 460px; opacity: 0.75; margin: 0; }

.vscode-log {
  max-width: min(640px, 100%);
  max-height: 160px;
  overflow: auto;
  font-size: 11px;
  text-align: left;
  opacity: 0.7;
  white-space: pre-wrap;
  margin: 0;
}
</style>
