<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Socket } from 'socket.io-client'
import {
  answerPhoneAgent, fetchPhoneAgentState, takeOverPhone,
  type PhoneAgentApproval, type PhoneAgentEntry,
} from '@/api/studio/android'

/**
 * Agents on the phone (docs/android-devices.md): whether agents may use this
 * device, the questions they ask, what they did, and Take over / Hand back.
 * Emits each new tap or swipe so the page can draw it on the live screen.
 */
const props = defineProps<{
  serial: string
  deviceName: string
  allowed: boolean
  saving: boolean
  socket: Socket | null
}>()
const emit = defineEmits<{
  (event: 'update:allowed', value: boolean): void
  (event: 'point', entry: PhoneAgentEntry): void
}>()

const { t, locale } = useI18n()
const toast = useMessage()
const log = ref<PhoneAgentEntry[]>([])
const approvals = ref<PhoneAgentApproval[]>([])
const held = ref<string[]>([])
const answering = ref('')
const taking = ref(false)

const deviceLog = computed(() => log.value.filter(entry => entry.serial === props.serial).slice(0, 20))
const isHeld = computed(() => held.value.includes(props.serial))
const time = (at: number) => new Date(at).toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function onAction(entry: PhoneAgentEntry) {
  const index = log.value.findIndex(item => item.id === entry.id)
  if (index >= 0) log.value.splice(index, 1, entry)
  else log.value = [entry, ...log.value].slice(0, 200)
  if (entry.status === 'done' && entry.point) emit('point', entry)
}
const onApproval = (approval: PhoneAgentApproval) => { approvals.value = [...approvals.value.filter(item => item.id !== approval.id), approval] }
const onResolved = (data: { id: string }) => { approvals.value = approvals.value.filter(item => item.id !== data.id) }
const onTakeOver = (data: { serial: string; held: boolean }) => {
  held.value = data.held ? [...new Set([...held.value, data.serial])] : held.value.filter(serial => serial !== data.serial)
}

function listen(socket: Socket | null, previous?: Socket | null) {
  previous?.off('agent.action', onAction)
  previous?.off('agent.approval', onApproval)
  previous?.off('agent.approval.resolved', onResolved)
  previous?.off('agent.takeover', onTakeOver)
  socket?.on('agent.action', onAction)
  socket?.on('agent.approval', onApproval)
  socket?.on('agent.approval.resolved', onResolved)
  socket?.on('agent.takeover', onTakeOver)
}

watch(() => props.socket, (socket, previous) => listen(socket, previous))

onMounted(async () => {
  listen(props.socket)
  try {
    const state = await fetchPhoneAgentState()
    log.value = Array.isArray(state?.log) ? state.log : []
    approvals.value = Array.isArray(state?.approvals) ? state.approvals : []
    held.value = Array.isArray(state?.takenOver) ? state.takenOver : []
  } catch { /* the page still works for people */ }
})
onBeforeUnmount(() => listen(null, props.socket))

async function answer(approval: PhoneAgentApproval, allow: boolean) {
  answering.value = approval.id
  try {
    await answerPhoneAgent(approval.id, allow)
    onResolved(approval)
  } catch (error) {
    toast.error((error as Error).message || t('android.agent.failed'))
  } finally {
    answering.value = ''
  }
}

async function toggleTakeOver() {
  taking.value = true
  try {
    onTakeOver(await takeOverPhone(props.serial, !isHeld.value))
  } catch (error) {
    toast.error((error as Error).message || t('android.agent.failed'))
  } finally {
    taking.value = false
  }
}
</script>

<template>
  <section class="android-agent" data-testid="android-agent-panel" :aria-label="t('android.agent.title')">
    <div class="android-agent-head">
      <h3>{{ t('android.agent.title') }}</h3>
      <span v-if="isHeld" class="android-agent-badge" data-testid="android-agent-held">{{ t('android.agent.youHaveIt') }}</span>
    </div>
    <label class="android-agent-row">
      <NSwitch
        size="small"
        :value="allowed"
        :loading="saving"
        :aria-label="t('android.agent.allow', { name: deviceName })"
        data-testid="android-agent-allow"
        @update:value="(value: boolean) => emit('update:allowed', value)"
      />
      <span>{{ t('android.agent.allow', { name: deviceName }) }}</span>
    </label>
    <p class="android-agent-hint">{{ allowed ? t('android.agent.allowedHint') : t('android.agent.notAllowedHint') }}</p>
    <NButton
      v-if="allowed"
      size="small"
      :type="isHeld ? 'primary' : 'default'"
      :loading="taking"
      data-testid="android-agent-takeover"
      @click="toggleTakeOver"
    >{{ isHeld ? t('android.agent.handBack') : t('android.agent.takeOver') }}</NButton>

    <div v-if="approvals.length" class="android-agent-questions" role="alert" data-testid="android-agent-questions">
      <div v-for="approval in approvals" :key="approval.id" class="android-agent-question">
        <p>{{ t('android.agent.asks', { agent: approval.agent, action: approval.summary, device: approval.device }) }}</p>
        <p v-if="approval.reason" class="android-agent-hint">{{ t('android.agent.because', { reason: approval.reason }) }}</p>
        <div class="android-agent-row">
          <NButton size="small" type="primary" :loading="answering === approval.id" data-testid="android-agent-allow-once" @click="answer(approval, true)">{{ t('android.agent.allowOnce') }}</NButton>
          <NButton size="small" :disabled="answering === approval.id" data-testid="android-agent-deny" @click="answer(approval, false)">{{ t('android.agent.deny') }}</NButton>
        </div>
      </div>
      <p class="android-agent-hint">{{ t('android.agent.trustHint') }}</p>
    </div>

    <h4>{{ t('android.agent.logTitle') }}</h4>
    <p v-if="!deviceLog.length" class="android-agent-hint">{{ t('android.agent.logEmpty') }}</p>
    <ol v-else class="android-agent-log" role="log" aria-live="polite" data-testid="android-agent-log">
      <li v-for="entry in deviceLog" :key="entry.id">
        <span class="android-agent-status" :data-status="entry.status">{{ t(`android.agent.status.${entry.status}`) }}</span>
        <span class="android-agent-summary">{{ entry.agent }}: {{ entry.summary }}</span>
        <time class="android-agent-time">{{ time(entry.at) }}</time>
      </li>
    </ol>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.android-agent {
  display: flex;
  flex-direction: column;
  gap: 6px;

  h3, h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }
}

.android-agent-head,
.android-agent-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.android-agent-head {
  justify-content: space-between;
}

.android-agent-badge {
  padding: 1px 8px;
  font-size: 12px;
  color: $accent-primary;
  border: var(--border-width, 1px) solid $accent-primary;
  border-radius: 999px;
}

.android-agent-hint {
  margin: 0;
  font-size: 12px;
  color: $text-muted;
}

.android-agent-questions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border: var(--border-width, 1px) solid $warning;
  border-radius: var(--radius-component, 8px);
}

.android-agent-question p {
  margin: 0 0 4px;
  font-size: 13px;
}

.android-agent-log {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;

  li {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 6px;
    align-items: baseline;
    font-size: 12px;
  }
}

.android-agent-status {
  font-weight: 600;

  &[data-status="done"] { color: $success; }
  &[data-status="waiting"] { color: $warning; }
  &[data-status="denied"],
  &[data-status="failed"] { color: $error; }
}

.android-agent-summary {
  overflow-wrap: anywhere;
}

.android-agent-time {
  color: $text-muted;
}
</style>
