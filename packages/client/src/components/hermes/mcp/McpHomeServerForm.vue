<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NAlert, NButton, NCheckbox, NInput, NModal, NRadioButton, NRadioGroup, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  buildHomeAssistantServer, buildUnraidServer, homeAssistantBuilderEnv, HomeServerFormError, saveHermesEnvValue, toolIncluded,
  type McpServerDraft, type UnraidAuth,
} from '@/api/hermes/extensions'
import { mcpServerAddWithSecrets, mcpServerTest } from '@/api/hermes/mcp'

/** Short forms that add Home Assistant's or Unraid's MCP server, then test the connection. */
const props = defineProps<{ kind: 'home-assistant' | 'unraid' | null }>()
const emit = defineEmits<{ close: []; added: [server: string] }>()

const { t } = useI18n()

const ha = reactive({ name: 'home-assistant', address: '', token: '', readOnly: true })
const builder = reactive({ enabled: false, sshHost: '', sshPort: '22', sshUser: 'root', sshKey: '', configDir: '/config' })
const unraid = reactive({ name: 'unraid', address: '', auth: 'token' as UnraidAuth, token: '', connectUrl: '' })
const busy = ref(false)
const error = ref('')
const result = ref<{ name: string; ok: boolean; tools: string[]; allowed: string[] | null; error?: string } | null>(null)

watch(() => props.kind, () => {
  ha.token = ''
  unraid.token = ''
  unraid.connectUrl = ''
  error.value = ''
  result.value = null
})

const title = computed(() => props.kind === 'unraid' ? t('hermesExtensions.home.unraid.title') : t('hermesExtensions.home.ha.title'))

function draft(): McpServerDraft {
  if (props.kind === 'home-assistant') return buildHomeAssistantServer(ha)
  return buildUnraidServer(unraid)
}

async function submit() {
  error.value = ''
  result.value = null
  let server: McpServerDraft
  let builderEnv: Record<string, string> = {}
  try {
    server = draft()
    if (props.kind === 'home-assistant' && builder.enabled) builderEnv = homeAssistantBuilderEnv(ha, builder)
  } catch (err) {
    error.value = err instanceof HomeServerFormError ? t(`hermesExtensions.home.errors.${err.code}`) : String(err)
    return
  }
  busy.value = true
  try {
    const added = await mcpServerAddWithSecrets(server.name, server.config, server.secrets)
    if (added && added.ok === false) throw new Error(added.error || t('hermesExtensions.home.addFailed'))
    for (const [key, value] of Object.entries(builderEnv)) await saveHermesEnvValue(key, value)
    ha.token = ''
    unraid.token = ''
    unraid.connectUrl = ''
    emit('added', server.name)
    const tested = await mcpServerTest(server.name).catch((err: any) => ({ ok: false, tools: [], error: err?.message }))
    const tools = tested.tools || []
    // The test lists every tool the server offers; a read-only include list lets Hermes use only some.
    const include = server.config.tools?.include
    const allowed = include ? tools.filter(tool => toolIncluded(tool, include)) : null
    result.value = { name: server.name, ok: !!tested.ok, tools, allowed, error: tested.error }
  } catch (err: any) {
    error.value = err?.message || t('hermesExtensions.home.addFailed')
  } finally {
    busy.value = false
  }
}

function close() {
  emit('close')
}
</script>

<template>
  <NModal
    :show="!!kind"
    preset="card"
    :title="title"
    :style="{ width: 'min(600px, calc(100vw - 32px))' }"
    @update:show="(value: boolean) => { if (!value) close() }"
  >
    <div class="home-form">
      <template v-if="kind === 'home-assistant'">
        <div class="steps">
          <strong>{{ t('hermesExtensions.home.ha.stepsTitle') }}</strong>
          <ol>
            <li>{{ t('hermesExtensions.home.ha.step1') }}</li>
            <li>{{ t('hermesExtensions.home.ha.step2') }}</li>
            <li>{{ t('hermesExtensions.home.ha.step3') }}</li>
          </ol>
        </div>
        <div class="field">
          <label>{{ t('hermesExtensions.home.ha.address') }} <span class="required">*</span></label>
          <NInput v-model:value="ha.address" size="small" placeholder="http://homeassistant.local:8123" />
          <span class="hint">{{ t('hermesExtensions.home.ha.addressHint') }}</span>
        </div>
        <div class="field">
          <label>{{ t('hermesExtensions.home.ha.token') }} <span class="required">*</span></label>
          <NInput v-model:value="ha.token" size="small" type="password" show-password-on="click" :input-props="{ autocomplete: 'off' }" />
        </div>
        <NCheckbox v-model:checked="ha.readOnly" size="small">{{ t('hermesExtensions.home.ha.readOnly') }}</NCheckbox>
        <span class="hint">{{ ha.readOnly ? t('hermesExtensions.home.ha.readOnlyHint') : t('hermesExtensions.home.ha.fullHint') }}</span>
        <div class="field">
          <label>{{ t('hermesExtensions.home.name') }}</label>
          <NInput v-model:value="ha.name" size="small" />
        </div>
        <NCheckbox v-model:checked="builder.enabled" size="small">{{ t('hermesExtensions.home.ha.builder') }}</NCheckbox>
        <template v-if="builder.enabled">
          <span class="hint">{{ t('hermesExtensions.home.ha.builderHint') }}</span>
          <div class="field-row">
            <div class="field grow">
              <label>{{ t('hermesExtensions.home.ha.sshHost') }} <span class="required">*</span></label>
              <NInput v-model:value="builder.sshHost" size="small" placeholder="homeassistant.local" />
            </div>
            <div class="field port">
              <label>{{ t('hermesExtensions.home.ha.sshPort') }}</label>
              <NInput v-model:value="builder.sshPort" size="small" />
            </div>
            <div class="field port">
              <label>{{ t('hermesExtensions.home.ha.sshUser') }}</label>
              <NInput v-model:value="builder.sshUser" size="small" />
            </div>
          </div>
          <div class="field">
            <label>{{ t('hermesExtensions.home.ha.sshKey') }}</label>
            <NInput v-model:value="builder.sshKey" size="small" placeholder="~/.ssh/id_ed25519" />
          </div>
          <div class="field">
            <label>{{ t('hermesExtensions.home.ha.configDir') }}</label>
            <NInput v-model:value="builder.configDir" size="small" />
          </div>
        </template>
      </template>

      <template v-else-if="kind === 'unraid'">
        <div class="steps">
          <strong>{{ t('hermesExtensions.home.unraid.stepsTitle') }}</strong>
          <ol>
            <li>{{ t('hermesExtensions.home.unraid.step1') }}</li>
            <li>{{ t('hermesExtensions.home.unraid.step2') }}</li>
            <li>{{ t('hermesExtensions.home.unraid.step3') }}</li>
          </ol>
        </div>
        <NRadioGroup v-model:value="unraid.auth" size="small">
          <NRadioButton value="token">{{ t('hermesExtensions.home.unraid.authToken') }}</NRadioButton>
          <NRadioButton value="connect-url">{{ t('hermesExtensions.home.unraid.authConnectUrl') }}</NRadioButton>
          <NRadioButton value="none">{{ t('hermesExtensions.home.unraid.authNone') }}</NRadioButton>
        </NRadioGroup>
        <template v-if="unraid.auth === 'connect-url'">
          <div class="field">
            <label>{{ t('hermesExtensions.home.unraid.connectUrl') }} <span class="required">*</span></label>
            <NInput v-model:value="unraid.connectUrl" size="small" type="password" show-password-on="click" :input-props="{ autocomplete: 'off' }" placeholder="http://tower.local:8043/mcp/…" />
          </div>
        </template>
        <template v-else>
          <div class="field">
            <label>{{ t('hermesExtensions.home.unraid.address') }} <span class="required">*</span></label>
            <NInput v-model:value="unraid.address" size="small" placeholder="tower.local" />
            <span class="hint">{{ t('hermesExtensions.home.unraid.addressHint') }}</span>
          </div>
          <div v-if="unraid.auth === 'token'" class="field">
            <label>{{ t('hermesExtensions.home.unraid.token') }} <span class="required">*</span></label>
            <NInput v-model:value="unraid.token" size="small" type="password" show-password-on="click" :input-props="{ autocomplete: 'off' }" />
          </div>
        </template>
        <span class="hint">{{ t('hermesExtensions.home.unraid.readOnlyHint') }}</span>
        <div class="field">
          <label>{{ t('hermesExtensions.home.name') }}</label>
          <NInput v-model:value="unraid.name" size="small" />
        </div>
      </template>

      <span class="hint">{{ t('hermesExtensions.home.secretNote') }}</span>
      <NAlert v-if="error" type="error" :bordered="false">{{ error }}</NAlert>
      <NAlert v-if="result" :type="result.ok ? 'success' : 'warning'" :bordered="false">
        <template v-if="result.ok">
          {{ t('hermesExtensions.home.testOk', { name: result.name, count: result.tools.length }) }}
          <template v-if="result.allowed">{{ t('hermesExtensions.home.readOnlyAllowed', { count: result.allowed.length }) }}</template>
          <div class="tools">
            <NTag v-for="tool in result.tools" :key="tool" size="small" round :type="!result.allowed || result.allowed.includes(tool) ? 'success' : 'default'" :class="{ off: result.allowed && !result.allowed.includes(tool) }">{{ tool }}</NTag>
          </div>
        </template>
        <template v-else>{{ t('hermesExtensions.home.testFailed', { name: result.name, error: result.error || '' }) }}</template>
      </NAlert>

      <div class="modal-actions">
        <NButton @click="close">{{ result ? t('hermesExtensions.common.done') : t('hermesExtensions.common.cancel') }}</NButton>
        <NButton v-if="!result" type="primary" :loading="busy" @click="submit">{{ t('hermesExtensions.home.addAndTest') }}</NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.home-form { display: flex; flex-direction: column; gap: calc(12px * var(--spacing-scale, 1)); }
.steps ol { margin: 6px 0 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
.steps { font-size: calc(var(--font-size-base, 14px) * 13 / 14); color: $text-secondary; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field-row { display: flex; gap: 8px; flex-wrap: wrap; }
.field.grow { flex: 1 1 200px; }
.field.port { width: 90px; }
.field label { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.hint { margin: 0; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.required { color: $error; }
.tools { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.tools .off { opacity: 0.55; text-decoration: line-through; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
