<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NForm, NFormItem, NInput, NModal, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { addTrustRule } from '@/api/studio/watcher'
import type { TrustKind, TrustRule, TrustScope, WatcherEvent } from '../../../../shared/watcher'

/**
 * "Trust this" (docs/watcher.md): allow an action pattern for a chat, an
 * Agent work task, an agent or a folder, with an optional expiry. From an
 * alert it starts filled in; from Settings it starts empty.
 */
const props = defineProps<{ event?: WatcherEvent | null }>()
const emit = defineEmits<{ close: []; saved: [rule: TrustRule] }>()
const { t } = useI18n()
const message = useMessage()

const event = props.event || null
const scopes = computed(() => {
  const list: Array<{ value: TrustScope; label: string; target: string }> = []
  if (!event) {
    return (['chat', 'task', 'agent', 'folder'] as TrustScope[]).map(value => ({ value, label: t(`watcher.trust.scope.${value}`), target: '' }))
  }
  if (event.sessionId) list.push({ value: 'chat', label: t('watcher.trust.scopeThisChat'), target: event.sessionId })
  if (event.taskId) list.push({ value: 'task', label: t('watcher.trust.scopeThisTask'), target: event.taskId })
  if (event.agent) list.push({ value: 'agent', label: t('watcher.trust.scopeThisAgent', { agent: event.agent }), target: event.agent })
  if (event.folder) list.push({ value: 'folder', label: t('watcher.trust.scopeThisFolder', { folder: event.folder }), target: event.folder })
  return list
})

const kind = ref<TrustKind>(event?.action?.kind || 'command')
const pattern = ref(event?.action?.value || '')
const scope = ref<TrustScope>(scopes.value[0]?.value || 'chat')
const target = ref(scopes.value[0]?.target || '')
const expiry = ref<string>('never')
const saving = ref(false)

const kindOptions = computed(() => (['command', 'write', 'tool'] as TrustKind[]).map(value => ({ value, label: t(`watcher.trust.kind.${value}`) })))
const expiryOptions = computed(() => [
  { value: 'never', label: t('watcher.trust.expiry.never') },
  { value: '3600000', label: t('watcher.trust.expiry.hour') },
  { value: '86400000', label: t('watcher.trust.expiry.day') },
  { value: '604800000', label: t('watcher.trust.expiry.week') },
  { value: '2592000000', label: t('watcher.trust.expiry.month') },
])

function pickScope(value: TrustScope) {
  scope.value = value
  if (event) target.value = scopes.value.find(item => item.value === value)?.target || ''
}

async function save() {
  saving.value = true
  try {
    const result = await addTrustRule({
      kind: kind.value,
      scope: scope.value,
      target: target.value.trim(),
      pattern: pattern.value.trim(),
      expiresAt: expiry.value === 'never' ? 0 : Date.now() + Number(expiry.value),
      note: event?.text || '',
    })
    message.success(t('watcher.trust.saved'))
    emit('saved', result.rule)
    emit('close')
  } catch (error: any) {
    message.error(String(error?.message || '').replace(/^API Error \d+: /, '') || t('watcher.actionFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    :show="true"
    preset="card"
    :title="t('watcher.trust.title')"
    class="watcher-trust-dialog"
    :style="{ width: 'min(520px, calc(100vw - 24px))' }"
    data-testid="watcher-trust-dialog"
    @update:show="(show: boolean) => { if (!show) emit('close') }"
  >
    <p class="watcher-trust-hint">{{ t('watcher.trust.hint') }}</p>
    <NForm label-placement="top" :show-feedback="false" class="watcher-trust-form">
      <NFormItem :label="t('watcher.trust.what')">
        <NSelect v-model:value="kind" :options="kindOptions" data-testid="watcher-trust-kind" />
      </NFormItem>
      <NFormItem :label="t('watcher.trust.pattern')">
        <NInput v-model:value="pattern" :placeholder="t('watcher.trust.patternPlaceholder')" data-testid="watcher-trust-pattern" />
      </NFormItem>
      <p class="watcher-trust-help">{{ t('watcher.trust.patternHint') }}</p>
      <NFormItem :label="t('watcher.trust.where')">
        <NSelect :value="scope" :options="scopes.map(item => ({ value: item.value, label: item.label }))" data-testid="watcher-trust-scope" @update:value="pickScope" />
      </NFormItem>
      <NFormItem v-if="!event" :label="t(`watcher.trust.targetLabel.${scope}`)">
        <NInput v-model:value="target" :placeholder="t(`watcher.trust.targetPlaceholder.${scope}`)" data-testid="watcher-trust-target" />
      </NFormItem>
      <NFormItem :label="t('watcher.trust.expires')">
        <NSelect v-model:value="expiry" :options="expiryOptions" data-testid="watcher-trust-expiry" />
      </NFormItem>
    </NForm>
    <template #footer>
      <div class="watcher-trust-footer">
        <NButton @click="emit('close')">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" :disabled="!pattern.trim() || !target.trim()" data-testid="watcher-trust-save" @click="save">{{ t('watcher.trust.save') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.watcher-trust-hint,
.watcher-trust-help {
  margin: 0 0 12px;
  color: $text-secondary;
  font-size: 13px;
}

.watcher-trust-help {
  margin: 4px 0 10px;
  color: $text-muted;
  font-size: 12px;
}

.watcher-trust-form :deep(.n-form-item) {
  margin-bottom: 10px;
}

.watcher-trust-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
