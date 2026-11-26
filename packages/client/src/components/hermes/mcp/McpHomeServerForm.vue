<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NAlert, NButton, NCheckbox, NInput, NModal, NRadioButton, NRadioGroup, NSelect, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  buildHomeAssistantServer, buildLlmWikiServer, buildOmiServer, buildUnraidServer, homeAssistantBuilderEnv, HomeServerFormError, saveHermesEnvValue, toolIncluded,
  type McpServerDraft, type UnraidAuth,
} from '@/api/hermes/extensions'
import { homeAssistantSshKey, mcpServerAddWithSecrets, mcpServerTest, type McpServerConfig } from '@/api/hermes/mcp'
import { installOmiSkill } from '@/api/studio/omi'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { copyToClipboard } from '@/utils/clipboard'

/**
 * Short forms that add Home Assistant's, Unraid's or Omi's MCP server, then
 * test the connection (the LLM wiki's form too, docs/llm-wiki.md). Omi's form also installs Omi's Hermes skill into a
 * profile ('omi-skill' shows only that part).
 */
const props = defineProps<{ kind: 'home-assistant' | 'unraid' | 'omi' | 'omi-skill' | 'llm-wiki' | null }>()
const emit = defineEmits<{ close: []; added: [server: string] }>()

const { t } = useI18n()

const ha = reactive({ name: 'home-assistant', address: '', token: '', readOnly: true })
// Home Assistant OS: the "Terminal & SSH" / "Advanced SSH & Web Terminal" add-on on port 22, signed in
// as root with a key. The config folder is found on the host (/homeassistant or /config).
const builder = reactive({ enabled: false, sshHost: '', sshPort: '22', sshUser: 'root', sshKey: '', configDir: '' })
const studioKey = ref<{ keyPath: string; publicKey: string } | null>(null)
const keyBusy = ref(false)
const keyError = ref('')
const keyCopied = ref(false)

async function useStudioKey() {
  keyBusy.value = true
  keyError.value = ''
  try {
    const key = await homeAssistantSshKey()
    studioKey.value = { keyPath: key.keyPath, publicKey: key.publicKey }
    builder.sshKey = key.keyPath
  } catch (err: any) {
    keyError.value = t('hermesExtensions.home.ha.keyFailed', { error: err?.message || String(err) })
  } finally {
    keyBusy.value = false
  }
}

async function copyPublicKey() {
  if (studioKey.value) keyCopied.value = await copyToClipboard(studioKey.value.publicKey)
}

// Key auth by default: the first time the builder is turned on, Studio's own key is filled in.
watch(() => builder.enabled, (on) => { if (on && !builder.sshKey && !studioKey.value) void useStudioKey() })
const unraid = reactive({ name: 'unraid', address: '', auth: 'token' as UnraidAuth, token: '', connectUrl: '' })
const omi = reactive({ name: 'omi', address: '', key: '' })
const wiki = reactive({ name: 'llm-wiki', address: '', token: '' })

// Omi's Hermes skill: copied into the chosen profile (the one this MCP page edits by default).
const profilesStore = useProfilesStore()
const skillProfile = ref('')
const skillBusy = ref(false)
const skillResult = ref<{ ok: boolean; text: string } | null>(null)
const profileOptions = computed(() => profilesStore.profiles.map(profile => ({ label: profile.name, value: profile.name })))
const isOmi = computed(() => props.kind === 'omi' || props.kind === 'omi-skill')

watch(isOmi, (on) => {
  if (!on) return
  skillResult.value = null
  skillProfile.value = skillProfile.value || profilesStore.activeProfileName || 'default'
  if (!profilesStore.profiles.length) void profilesStore.fetchProfiles().catch(() => undefined)
}, { immediate: true })

async function addSkill() {
  skillBusy.value = true
  skillResult.value = null
  try {
    const result = await installOmiSkill(skillProfile.value || 'default')
    skillResult.value = { ok: true, text: t('omi.mcp.skillAdded', { profile: result.profile }) }
  } catch (err: any) {
    skillResult.value = { ok: false, text: err?.message || String(err) }
  } finally {
    skillBusy.value = false
  }
}
const busy = ref(false)
const error = ref('')
const result = ref<{ name: string; ok: boolean; tools: string[]; allowed: string[] | null; error?: string } | null>(null)

watch(() => props.kind, () => {
  ha.token = ''
  unraid.token = ''
  unraid.connectUrl = ''
  omi.key = ''
  wiki.token = ''
  error.value = ''
  result.value = null
})

const title = computed(() => props.kind === 'unraid' ? t('hermesExtensions.home.unraid.title')
  : props.kind === 'omi' ? t('omi.mcp.title')
    : props.kind === 'llm-wiki' ? t('llmWiki.mcp.title')
    : props.kind === 'omi-skill' ? t('omi.mcp.skillTitle')
      : t('hermesExtensions.home.ha.title'))

function draft(): McpServerDraft {
  if (props.kind === 'home-assistant') return buildHomeAssistantServer(ha)
  if (props.kind === 'omi') return buildOmiServer(omi)
  if (props.kind === 'llm-wiki') return buildLlmWikiServer(wiki)
  return buildUnraidServer(unraid)
}

function formError(err: HomeServerFormError): string {
  if (props.kind === 'omi' && err.code === 'token') return t('omi.mcp.keyError')
  if (props.kind === 'llm-wiki' && err.code === 'token') return t('llmWiki.mcp.tokenError')
  return t(`hermesExtensions.home.errors.${err.code}`)
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
    error.value = err instanceof HomeServerFormError ? formError(err) : String(err)
    return
  }
  busy.value = true
  try {
    const added = await mcpServerAddWithSecrets(server.name, server.config as McpServerConfig, server.secrets)
    if (added && added.ok === false) throw new Error(added.error || t('hermesExtensions.home.addFailed'))
    for (const [key, value] of Object.entries(builderEnv)) await saveHermesEnvValue(key, value)
    ha.token = ''
    omi.key = ''
    wiki.token = ''
    unraid.token = ''
    unraid.connectUrl = ''
    emit('added', server.name)
    const tested = await mcpServerTest(server.name).catch((err: any) => ({ ok: false, tools: [], error: err?.message }))
    const tools = tested.tools || []
    // The test lists every tool the server offers; a read-only include list lets Hermes use only some.
    const include = server.config.tools?.include
    // Omi's delete tools are excluded; they show as off like Home Assistant's non-read tools.
    const exclude = server.config.tools?.exclude
    const allowed = include ? tools.filter(tool => toolIncluded(tool, include)) : exclude ? tools.filter(tool => !toolIncluded(tool, exclude)) : null
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
              <NInput v-model:value="builder.sshPort" size="small" placeholder="22" />
            </div>
            <div class="field port">
              <label>{{ t('hermesExtensions.home.ha.sshUser') }}</label>
              <NInput v-model:value="builder.sshUser" size="small" placeholder="root" />
            </div>
          </div>
          <span class="hint">{{ t('hermesExtensions.home.ha.sshHostHint') }} {{ t('hermesExtensions.home.ha.sshUserHint') }}</span>
          <div class="field">
            <label>{{ t('hermesExtensions.home.ha.sshKey') }}</label>
            <div class="key-row">
              <NInput v-model:value="builder.sshKey" size="small" placeholder="~/.ssh/id_ed25519" />
              <NButton size="small" :loading="keyBusy" @click="useStudioKey">{{ t('hermesExtensions.home.ha.useStudioKey') }}</NButton>
            </div>
          </div>
          <NAlert v-if="keyError" type="error" :bordered="false">{{ keyError }}</NAlert>
          <div v-if="studioKey && builder.sshKey === studioKey.keyPath" class="steps key-steps">
            <ol>
              <li>{{ t('hermesExtensions.home.ha.keyStep1') }}</li>
              <li>{{ t('hermesExtensions.home.ha.keyStep2') }}</li>
            </ol>
            <NInput :value="studioKey.publicKey" type="textarea" size="small" readonly :autosize="{ minRows: 2, maxRows: 3 }" class="public-key" />
            <NButton size="small" @click="copyPublicKey">{{ keyCopied ? t('hermesExtensions.home.ha.keyCopied') : t('hermesExtensions.home.ha.copyKey') }}</NButton>
          </div>
          <div class="field">
            <label>{{ t('hermesExtensions.home.ha.configDir') }}</label>
            <NInput v-model:value="builder.configDir" size="small" :placeholder="t('hermesExtensions.home.ha.configDirPlaceholder')" />
            <span class="hint">{{ t('hermesExtensions.home.ha.configDirHint') }}</span>
          </div>
          <span class="hint">{{ t('hermesExtensions.home.ha.packagesHint') }}</span>
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

      <template v-else-if="kind === 'omi'">
        <div class="steps">
          <strong>{{ t('omi.mcp.stepsTitle') }}</strong>
          <ol>
            <li>{{ t('omi.mcp.step1') }}</li>
            <li>{{ t('omi.mcp.step2') }}</li>
          </ol>
        </div>
        <div class="field">
          <label for="omi-mcp-address">{{ t('omi.mcp.address') }} <span class="required">*</span></label>
          <NInput v-model:value="omi.address" size="small" placeholder="http://omi.lan:8000" :input-props="{ id: 'omi-mcp-address' }" data-testid="omi-mcp-address" />
        </div>
        <div class="field">
          <label for="omi-mcp-key">{{ t('omi.mcp.key') }} <span class="required">*</span></label>
          <NInput v-model:value="omi.key" size="small" type="password" show-password-on="click" placeholder="omi_mcp_…" :input-props="{ id: 'omi-mcp-key', autocomplete: 'off' }" data-testid="omi-mcp-key" />
        </div>
        <span class="hint">{{ t('omi.mcp.excludeHint') }}</span>
        <div class="field">
          <label for="omi-mcp-name">{{ t('hermesExtensions.home.name') }}</label>
          <NInput v-model:value="omi.name" size="small" :input-props="{ id: 'omi-mcp-name' }" />
        </div>
      </template>

      <template v-else-if="kind === 'llm-wiki'">
        <div class="steps">
          <strong>{{ t('llmWiki.mcp.stepsTitle') }}</strong>
          <ol>
            <li>{{ t('llmWiki.mcp.step1') }}</li>
            <li>{{ t('llmWiki.mcp.step2') }}</li>
          </ol>
        </div>
        <div class="field">
          <label for="llm-wiki-mcp-address">{{ t('llmWiki.mcp.address') }} <span class="required">*</span></label>
          <NInput v-model:value="wiki.address" size="small" placeholder="http://wiki.lan:27123" :input-props="{ id: 'llm-wiki-mcp-address' }" data-testid="llm-wiki-mcp-address" />
        </div>
        <div class="field">
          <label for="llm-wiki-mcp-token">{{ t('llmWiki.mcp.token') }} <span class="required">*</span></label>
          <NInput v-model:value="wiki.token" size="small" type="password" show-password-on="click" placeholder="llmw_…" :input-props="{ id: 'llm-wiki-mcp-token', autocomplete: 'off' }" data-testid="llm-wiki-mcp-token" />
        </div>
        <span class="hint">{{ t('llmWiki.mcp.privacyHint') }}</span>
        <div class="field">
          <label for="llm-wiki-mcp-name">{{ t('hermesExtensions.home.name') }}</label>
          <NInput v-model:value="wiki.name" size="small" :input-props="{ id: 'llm-wiki-mcp-name' }" />
        </div>
      </template>

      <div v-if="isOmi" class="steps skill-box" data-testid="omi-skill-box">
        <strong>{{ t('omi.mcp.skillTitle') }}</strong>
        <span class="hint">{{ t('omi.mcp.skillHint') }}</span>
        <div class="key-row">
          <NSelect v-model:value="skillProfile" size="small" :options="profileOptions" :aria-label="t('omi.mcp.skillProfile')" data-testid="omi-skill-profile" />
          <NButton size="small" :loading="skillBusy" data-testid="omi-skill-add" @click="addSkill">{{ t('omi.mcp.addSkill') }}</NButton>
        </div>
        <span v-if="skillResult" class="hint" :class="skillResult.ok ? 'ok' : 'bad'" role="status" aria-live="polite" data-testid="omi-skill-result">{{ skillResult.text }}</span>
      </div>

      <span v-if="kind !== 'omi-skill'" class="hint">{{ t('hermesExtensions.home.secretNote') }}</span>
      <NAlert v-if="error" type="error" :bordered="false">{{ error }}</NAlert>
      <NAlert v-if="result" :type="result.ok ? 'success' : 'warning'" :bordered="false">
        <template v-if="result.ok">
          {{ t('hermesExtensions.home.testOk', { name: result.name, count: result.tools.length }) }}
          <template v-if="result.allowed">{{ kind === 'omi' ? t('omi.mcp.excludeHint') : kind === 'llm-wiki' ? t('llmWiki.mcp.excludeHint') : t('hermesExtensions.home.readOnlyAllowed', { count: result.allowed.length }) }}</template>
          <div class="tools">
            <NTag v-for="tool in result.tools" :key="tool" size="small" round :type="!result.allowed || result.allowed.includes(tool) ? 'success' : 'default'" :class="{ off: result.allowed && !result.allowed.includes(tool) }">{{ tool }}</NTag>
          </div>
        </template>
        <template v-else>{{ t('hermesExtensions.home.testFailed', { name: result.name, error: result.error || '' }) }}</template>
      </NAlert>

      <div class="modal-actions">
        <NButton @click="close">{{ result ? t('hermesExtensions.common.done') : t('hermesExtensions.common.cancel') }}</NButton>
        <NButton v-if="!result && kind !== 'omi-skill'" type="primary" :loading="busy" data-testid="mcp-home-submit" @click="submit">{{ t('hermesExtensions.home.addAndTest') }}</NButton>
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
.skill-box { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: var(--border-width, 1px) solid $border-light; }
.hint.ok { color: $success; }
.hint.bad { color: $error; }
.key-row { display: flex; gap: 8px; align-items: center; }
.key-row > :first-child { flex: 1 1 auto; }
.key-steps { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.public-key { font-family: var(--font-mono, monospace); font-size: 12px; }
.tools { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.tools .off { opacity: 0.55; text-decoration: line-through; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
