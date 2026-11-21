<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NInputNumber, NModal, NRadioButton, NRadioGroup, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchChatRunLimits, saveChatRunLimits, type ChatRunLimits } from '@/api/studio/run-limits'
import { LIMIT_FIELDS, type RunLimitKind, type RunLimitOverrides, type RunLimits } from '../../../../../shared/run-limits'
import { LIMIT_INPUT, LIMIT_KINDS, formatLimit, limitValue } from './run-limit-format'

/** Chat menu → Run limits: this chat's own limits over Settings' (docs/agent-limits.md). */
const props = defineProps<{ show: boolean; sessionId: string | null }>()
const emit = defineEmits<{ 'update:show': [value: boolean] }>()
const { t, locale } = useI18n()
const toast = useMessage()

type Mode = 'settings' | 'off' | 'custom'
const data = ref<ChatRunLimits | null>(null)
const modes = ref<Record<RunLimitKind, Mode>>({ cost: 'settings', tokens: 'settings', time: 'settings', loop: 'settings' })
const values = ref<Record<RunLimitKind, number>>({ cost: 2, tokens: 500000, time: 30, loop: 5 })
const saving = ref(false)

const words = computed(() => ({
  off: t('runLimits.off'),
  unit: { cost: t('runLimits.unit.cost'), tokens: t('runLimits.unit.tokens'), time: t('runLimits.unit.time'), loop: t('runLimits.unit.loop') } as Record<RunLimitKind, string>,
}))
const LABEL: Record<RunLimitKind, string> = { cost: 'cost', tokens: 'tokens', time: 'time', loop: 'loop' }

function applyData(next: ChatRunLimits) {
  data.value = next
  for (const kind of LIMIT_KINDS) {
    const field = LIMIT_FIELDS[kind]
    const own = next.overrides[field]
    modes.value[kind] = !(field in next.overrides) ? 'settings' : own == null ? 'off' : 'custom'
    values.value[kind] = own ?? limitValue(next.defaults, kind) ?? LIMIT_INPUT[kind].default
  }
}

watch(() => [props.show, props.sessionId] as const, async ([show, id]) => {
  if (!show || !id) return
  data.value = null
  try { applyData(await fetchChatRunLimits(id)) } catch (error: any) { toast.error(error?.message || t('runLimits.loadFailed')) }
}, { immediate: true })

const runLine = computed(() => {
  const run = data.value?.run
  if (!run) return ''
  return t('runLimits.thisRun', {
    cost: formatLimit('cost', run.costUsd, words.value, locale.value),
    tokens: Math.round(run.tokens).toLocaleString(locale.value),
    minutes: run.minutes,
  })
})

function settingsValue(kind: RunLimitKind) {
  return data.value ? formatLimit(kind, limitValue(data.value.defaults as RunLimits, kind), words.value, locale.value) : ''
}

async function save() {
  const id = props.sessionId
  if (!id || saving.value) return
  const limits: RunLimitOverrides = {}
  const clear: Array<keyof RunLimits> = []
  for (const kind of LIMIT_KINDS) {
    const field = LIMIT_FIELDS[kind]
    if (modes.value[kind] === 'settings') clear.push(field)
    else limits[field] = modes.value[kind] === 'off' ? null : values.value[kind]
  }
  saving.value = true
  try {
    applyData(await saveChatRunLimits(id, { limits, clear }))
    toast.success(t('runLimits.saved'))
    emit('update:show', false)
  } catch (error: any) {
    toast.error(error?.message || t('runLimits.saveFailed'))
  } finally {
    saving.value = false
  }
}

function followSettings() {
  for (const kind of LIMIT_KINDS) modes.value[kind] = 'settings'
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="run-limits-modal"
    :title="t('runLimits.chatTitle')"
    :bordered="false"
    data-testid="run-limits-modal"
    @update:show="value => emit('update:show', value)"
  >
    <p class="run-limits-modal__hint">{{ t('runLimits.chatHint') }}</p>
    <div v-for="kind in LIMIT_KINDS" :key="kind" class="run-limits-modal__row">
      <div class="run-limits-modal__label">
        <span class="run-limits-modal__name">{{ t(`runLimits.${LABEL[kind]}`) }}</span>
        <span class="run-limits-modal__settings">{{ t('runLimits.followsSettings', { value: settingsValue(kind) }) }}</span>
      </div>
      <div class="run-limits-modal__control">
        <NRadioGroup v-model:value="modes[kind]" size="small" :data-testid="`chat-limit-${kind}-mode`">
          <NRadioButton value="settings">{{ t('runLimits.mode.settings') }}</NRadioButton>
          <NRadioButton value="off">{{ t('runLimits.mode.off') }}</NRadioButton>
          <NRadioButton value="custom">{{ t('runLimits.mode.custom') }}</NRadioButton>
        </NRadioGroup>
        <NInputNumber
          v-if="modes[kind] === 'custom'"
          v-model:value="values[kind]"
          :min="LIMIT_INPUT[kind].min"
          :step="LIMIT_INPUT[kind].step"
          :precision="LIMIT_INPUT[kind].precision"
          size="small"
          class="run-limits-modal__input"
          :data-testid="`chat-limit-${kind}-input`"
        >
          <template #suffix>{{ t(`runLimits.unit.${kind}`) }}</template>
        </NInputNumber>
      </div>
    </div>
    <p v-if="runLine" class="run-limits-modal__run">{{ runLine }}</p>
    <template #footer>
      <div class="run-limits-modal__footer">
        <NButton size="small" quaternary @click="followSettings">{{ t('runLimits.resetAll') }}</NButton>
        <NButton size="small" type="primary" :loading="saving" :disabled="!data" data-testid="chat-limits-save" @click="save">{{ t('runLimits.save') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.run-limits-modal__hint {
  margin: 0 0 12px;
  color: $text-secondary;
  font-size: 13px;
}

.run-limits-modal__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: var(--border-width, 1px) solid $border-light;
  flex-wrap: wrap;
}

.run-limits-modal__label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 140px;
}

.run-limits-modal__name {
  font-weight: 600;
  font-size: 14px;
}

.run-limits-modal__settings {
  color: $text-muted;
  font-size: 12px;
}

.run-limits-modal__control {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.run-limits-modal__input {
  width: 160px;
}

.run-limits-modal__run {
  margin: 12px 0 0;
  color: $text-secondary;
  font-size: 12px;
}

.run-limits-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

<style lang="scss">
.run-limits-modal {
  width: min(620px, calc(100vw - 32px));
}
</style>
