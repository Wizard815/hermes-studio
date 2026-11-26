<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NModal, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  cancelMcpOAuthFlow, deliverMcpOAuthCallback, getMcpOAuthFlow, parseOAuthRedirect, startMcpOAuth,
  type McpOAuthFlow,
} from '@/api/hermes/extensions'

/**
 * Signs Hermes in to an MCP server that uses OAuth. Studio asks Hermes to
 * start the sign-in, opens the provider's page, and watches until Hermes has
 * the token. Hermes's sign-in returns to Hermes's own local port; when the
 * browser cannot reach it (Studio on another machine), the user pastes the
 * address the browser landed on and Studio hands it to Hermes.
 */
const props = defineProps<{ show: boolean; server: string }>()
const emit = defineEmits<{ 'update:show': [value: boolean]; connected: [server: string] }>()

const { t } = useI18n()
const flow = ref<McpOAuthFlow | null>(null)
const starting = ref(false)
const error = ref('')
const pasted = ref('')
const pasteError = ref('')
const delivering = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

const status = computed(() => flow.value?.status || (starting.value ? 'starting' : ''))

function stopPolling() {
  if (timer) clearTimeout(timer)
  timer = null
}

function poll() {
  stopPolling()
  timer = setTimeout(async () => {
    const current = flow.value
    if (!current || !props.show) return
    try {
      const next = await getMcpOAuthFlow(current.flow_id)
      if (flow.value?.flow_id !== current.flow_id) return
      flow.value = next
      if (next.status === 'approved') { emit('connected', props.server); return }
      if (next.status === 'error') { error.value = next.error || t('hermesExtensions.oauth.failed'); return }
    } catch (err: any) {
      error.value = err?.message || t('hermesExtensions.oauth.failed')
      return
    }
    poll()
  }, 2000)
}

async function start() {
  stopPolling()
  flow.value = null
  error.value = ''
  pasted.value = ''
  pasteError.value = ''
  starting.value = true
  try {
    const next = await startMcpOAuth(props.server)
    flow.value = next
    if (next.status === 'error') error.value = next.error || t('hermesExtensions.oauth.failed')
    else if (next.status === 'approved') emit('connected', props.server)
    else poll()
  } catch (err: any) {
    error.value = err?.message || t('hermesExtensions.oauth.failed')
  } finally {
    starting.value = false
  }
}

function openSignIn() {
  if (flow.value?.authorization_url) window.open(flow.value.authorization_url, '_blank', 'noopener')
}

async function submitPasted() {
  const params = parseOAuthRedirect(pasted.value)
  if (!params) { pasteError.value = t('hermesExtensions.oauth.pasteInvalid'); return }
  pasteError.value = ''
  delivering.value = true
  try {
    await deliverMcpOAuthCallback(props.server, params)
    poll()
  } catch (err: any) {
    pasteError.value = err?.message || t('hermesExtensions.oauth.failed')
  } finally {
    delivering.value = false
  }
}

function close() {
  const current = flow.value
  stopPolling()
  if (current && (current.status === 'starting' || current.status === 'authorization_required')) {
    void cancelMcpOAuthFlow(current.flow_id).catch(() => {})
  }
  flow.value = null
  emit('update:show', false)
}

watch(() => props.show, (show) => { if (show) void start(); else stopPolling() }, { immediate: true })
onUnmounted(stopPolling)
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="t('hermesExtensions.oauth.title', { name: server })"
    :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    @update:show="(value: boolean) => { if (!value) close() }"
  >
    <div class="oauth-body">
      <div v-if="status === 'starting' && !error" class="oauth-row">
        <NSpin size="small" />
        <span>{{ t('hermesExtensions.oauth.starting') }}</span>
      </div>

      <template v-else-if="status === 'authorization_required' && !error">
        <p>{{ t('hermesExtensions.oauth.step1') }}</p>
        <NButton type="primary" block @click="openSignIn">{{ t('hermesExtensions.oauth.openSignIn') }}</NButton>
        <div class="oauth-row muted">
          <NSpin size="small" />
          <span>{{ t('hermesExtensions.oauth.waiting') }}</span>
        </div>
        <p class="muted small">{{ t('hermesExtensions.oauth.pasteHelp') }}</p>
        <div class="oauth-paste">
          <NInput
            v-model:value="pasted"
            size="small"
            :placeholder="t('hermesExtensions.oauth.pastePlaceholder')"
            :status="pasteError ? 'error' : undefined"
            @keydown.enter="submitPasted"
          />
          <NButton size="small" :loading="delivering" :disabled="!pasted.trim()" @click="submitPasted">
            {{ t('hermesExtensions.oauth.pasteSubmit') }}
          </NButton>
        </div>
        <div v-if="pasteError" class="paste-error">{{ pasteError }}</div>
      </template>

      <NAlert v-else-if="status === 'approved'" type="success" :bordered="false">
        {{ t('hermesExtensions.oauth.connected', { name: server }) }}
      </NAlert>

      <NAlert v-if="error" type="error" :bordered="false">{{ error }}</NAlert>

      <div class="oauth-actions">
        <NButton v-if="error" size="small" @click="start">{{ t('hermesExtensions.oauth.retry') }}</NButton>
        <NButton size="small" @click="close">
          {{ status === 'approved' ? t('hermesExtensions.common.done') : t('hermesExtensions.common.cancel') }}
        </NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.oauth-body { display: flex; flex-direction: column; gap: calc(12px * var(--spacing-scale, 1)); }
.oauth-body p { margin: 0; }
.oauth-row { display: flex; align-items: center; gap: calc(8px * var(--spacing-scale, 1)); }
.oauth-paste { display: flex; gap: calc(8px * var(--spacing-scale, 1)); }
.muted { color: $text-muted; }
.small { font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.paste-error { color: $error; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.oauth-actions { display: flex; justify-content: flex-end; gap: calc(8px * var(--spacing-scale, 1)); }
</style>
