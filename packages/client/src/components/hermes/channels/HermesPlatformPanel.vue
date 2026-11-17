<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NSwitch, NTag, NCollapseTransition, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { testHermesPlatform, updateHermesPlatform, type HermesEnvField, type HermesPlatform, type HermesPlatformTest } from '@/api/hermes/channels'
import SettingRow from '@/components/hermes/settings/SettingRow.vue'
import HermesOnboarding from './HermesOnboarding.vue'
import HermesMattermostGuide from './HermesMattermostGuide.vue'
import HermesMattermostSetup from './HermesMattermostSetup.vue'
import { FIELD_TEXT_PREFIX, buildPlatformUpdate, cleanError, hasUpdate, panelFields, stateKey, stateTagType } from './channel-helpers'
import { useHermesChannels } from './useHermesChannels'

const props = defineProps<{
  platform: HermesPlatform
  /** Inside one of Studio's own channel cards: leave out the fields that card already edits. */
  embedded?: boolean
}>()
const emit = defineEmits<{ saved: [] }>()

const { t, te } = useI18n()
const message = useMessage()
const channels = useHermesChannels()

const drafts = reactive<Record<string, string | undefined>>({})
const clears = ref<string[]>([])
const enabledDraft = ref<boolean | undefined>(undefined)
const showAdvanced = ref(false)
const saving = ref(false)
const testing = ref(false)
const testResult = ref<HermesPlatformTest | null>(null)

const fields = computed(() => panelFields(props.platform, !!props.embedded))
const allFields = computed(() => [...fields.value.basic, ...fields.value.advanced])
const enabled = computed(() => enabledDraft.value ?? props.platform.enabled)
const update = computed(() => buildPlatformUpdate(
  allFields.value, drafts, clears.value,
  enabledDraft.value !== undefined && enabledDraft.value !== props.platform.enabled ? enabledDraft.value : undefined,
))
const dirty = computed(() => hasUpdate(update.value))
const hasOnboarding = computed(() => props.platform.id === 'telegram' || props.platform.id === 'whatsapp')

function resetDrafts() {
  for (const key of Object.keys(drafts)) delete drafts[key]
  for (const field of props.platform.env_vars) if (field.is_list) drafts[field.key] = field.value || ''
  clears.value = []
  enabledDraft.value = undefined
}
watch(() => props.platform, resetDrafts, { immediate: true })

/** Studio's own wording for this field, when it has one; otherwise Hermes's. */
function studioText(field: HermesEnvField, part: 'label' | 'hint' | 'placeholder'): string {
  const prefix = FIELD_TEXT_PREFIX[props.platform.id]
  const key = prefix && `${prefix}.${field.key}.${part}`
  return key && te(key) ? t(key) : ''
}

function label(field: HermesEnvField) {
  return studioText(field, 'label') || field.prompt || field.key
}

function hint(field: HermesEnvField) {
  const text = studioText(field, 'hint') || [field.description, field.help].filter(Boolean).join(' ')
  return field.required ? `${t('hermesChannels.required')} · ${text}` : text
}

function fieldPlaceholder(field: HermesEnvField) {
  return studioText(field, 'placeholder') || field.key
}

function placeholder(field: HermesEnvField) {
  if (clears.value.includes(field.key)) return t('hermesChannels.willBeRemoved')
  if (field.is_set && !field.is_list) return t('hermesChannels.keepCurrent')
  return fieldPlaceholder(field)
}

function toggleClear(field: HermesEnvField) {
  clears.value = clears.value.includes(field.key) ? clears.value.filter(k => k !== field.key) : [...clears.value, field.key]
  drafts[field.key] = field.is_list ? '' : undefined
}

async function save() {
  saving.value = true
  try {
    await updateHermesPlatform(props.platform.id, update.value)
    channels.markRestartNeeded()
    message.success(t('hermesChannels.savedRestart'))
    testResult.value = null
    await channels.load()
    emit('saved')
  } catch (err) {
    message.error(cleanError(err, t('hermesChannels.saveFailed')))
  } finally {
    saving.value = false
  }
}

async function runTest() {
  testing.value = true
  try {
    testResult.value = await testHermesPlatform(props.platform.id)
  } catch (err) {
    testResult.value = { ok: false, state: 'error', message: cleanError(err, t('hermesChannels.testFailed')) }
  } finally {
    testing.value = false
  }
}

const testAlertType = computed(() => {
  const r = testResult.value
  if (!r) return 'info'
  if (!r.ok) return 'error'
  return r.auth_posture === 'deny_all' ? 'warning' : 'success'
})

async function onboarded() {
  channels.markRestartNeeded(false)
  await channels.load()
  emit('saved')
}
</script>

<template>
  <div class="hermes-panel" :class="{ embedded }">
    <div class="status-row">
      <div class="status-left">
        <NTag :type="stateTagType(platform.state)" size="small" round>{{ t(`hermesChannels.state.${stateKey(platform.state)}`) }}</NTag>
        <span v-if="embedded" class="status-caption">{{ t('hermesChannels.agentStatus') }}</span>
        <a v-if="platform.docs_url" :href="platform.docs_url" target="_blank" rel="noopener" class="docs-link">{{ t('hermesChannels.docs') }}</a>
      </div>
      <div class="status-right">
        <span class="enable-label">{{ t('hermesChannels.enabled') }}</span>
        <NSwitch size="small" :value="enabled" :disabled="saving" @update:value="v => (enabledDraft = v)" />
        <NButton size="small" secondary :loading="testing" @click="runTest">{{ t('hermesChannels.test') }}</NButton>
      </div>
    </div>

    <p v-if="!embedded && platform.description" class="description">{{ platform.description }}</p>
    <NAlert v-if="platform.error_message" type="error" :show-icon="false" class="inline-alert">{{ platform.error_message }}</NAlert>
    <NAlert v-if="platform.disabled_by_relay || platform.relay_exclusive" type="info" :show-icon="false" class="inline-alert">{{ t('hermesChannels.relayNote') }}</NAlert>
    <NAlert v-if="platform.ingress_url" type="info" :show-icon="false" class="inline-alert">{{ t('hermesChannels.ingressUrl') }}: <code>{{ platform.ingress_url }}</code></NAlert>
    <NAlert v-if="testResult" :type="testAlertType" :show-icon="false" class="inline-alert" closable @close="testResult = null">{{ testResult.message }}</NAlert>

    <HermesOnboarding v-if="hasOnboarding" :platform="platform" @done="onboarded" />
    <HermesMattermostGuide v-if="platform.id === 'mattermost'" :configured="platform.configured" />

    <template v-for="(group, gi) in [fields.basic, fields.advanced]" :key="gi">
      <NCollapseTransition :show="gi === 0 || showAdvanced">
        <SettingRow v-for="field in group" :key="field.key" :label="label(field)" :hint="hint(field)">
          <div class="field-control">
            <NTag v-if="field.is_set && !field.is_list && !clears.includes(field.key)" size="small" type="success" :bordered="false">{{ t('hermesChannels.set') }}</NTag>
            <NInput
              :value="drafts[field.key] ?? ''"
              :type="field.is_password ? 'password' : 'text'"
              :show-password-on="field.is_password ? 'click' : undefined"
              :placeholder="placeholder(field)"
              :disabled="clears.includes(field.key)"
              :input-props="{ autocomplete: 'off' }"
              size="small"
              class="input-lg"
              clearable
              @update:value="v => (drafts[field.key] = v)"
            />
            <NButton v-if="field.is_set" size="tiny" quaternary :type="clears.includes(field.key) ? 'default' : 'error'" @click="toggleClear(field)">
              {{ clears.includes(field.key) ? t('hermesChannels.undo') : t('hermesChannels.remove') }}
            </NButton>
            <a v-if="field.url" :href="field.url" target="_blank" rel="noopener" class="docs-link">↗</a>
          </div>
        </SettingRow>
      </NCollapseTransition>
    </template>

    <div class="panel-actions">
      <NButton v-if="fields.advanced.length" size="small" quaternary @click="showAdvanced = !showAdvanced">
        {{ showAdvanced ? t('hermesChannels.fewerSettings') : t('hermesChannels.moreSettings', { count: fields.advanced.length }) }}
      </NButton>
      <span v-else />
      <div class="actions-right">
        <NButton v-if="dirty" size="small" quaternary @click="resetDrafts">{{ t('hermesChannels.discard') }}</NButton>
        <NButton type="primary" size="small" :loading="saving" :disabled="!dirty" @click="save">{{ embedded ? t('hermesChannels.saveAgent') : t('hermesChannels.save') }}</NButton>
      </div>
    </div>

    <HermesMattermostSetup v-if="platform.id === 'mattermost'" :platform="platform" :test-ok="!!testResult?.ok" @done="onboarded" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.hermes-panel {
  padding-top: 12px;

  &.embedded {
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: var(--border-width, 1px) dashed $border-light;
  }
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.status-left,
.status-right,
.field-control,
.actions-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-caption,
.enable-label {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
}

.docs-link {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-secondary;
}

.description {
  margin: 8px 0 0;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-secondary;
}

.inline-alert {
  margin-top: 8px;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  word-break: break-word;
}

.panel-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
}

.input-lg {
  min-width: 220px;
}
</style>
