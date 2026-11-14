<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, NInputNumber, NRadio, NRadioGroup, NSpin, NSwitch, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import SettingRow from './SettingRow.vue'
import { fetchConfig, updateConfigSection } from '@/api/hermes/config'
import {
  TERMINAL_COMMON_FIELDS, TERMINAL_FIELDS, getComputerUseStatus, listTerminalBackends, setTerminalBackend,
  terminalChanges, type ComputerUseStatus, type TerminalBackend, type TerminalField,
} from '@/api/hermes/agent-tools'

const { t, te } = useI18n()
const message = useMessage()

const loading = ref(true)
const loadError = ref('')
const backends = ref<TerminalBackend[]>([])
const active = ref('local')
const switching = ref(false)
const saved = ref<Record<string, any>>({})
const form = ref<Record<string, any>>({})
const saving = ref(false)
const computerUse = ref<ComputerUseStatus | null>(null)

const fields = computed<TerminalField[]>(() => [...(TERMINAL_FIELDS[active.value] || []), ...TERMINAL_COMMON_FIELDS])
const dirty = computed(() => Object.keys(terminalChanges(fields.value, saved.value, form.value)).length > 0)

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const [list, cfg] = await Promise.all([listTerminalBackends(), fetchConfig(['terminal'])])
    backends.value = list.backends
    active.value = list.active
    saved.value = { ...((cfg as any)?.terminal || {}) }
    form.value = { ...saved.value }
  } catch (err: any) {
    loadError.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
  computerUse.value = await getComputerUseStatus().catch(() => null)
}

async function choose(name: string) {
  const previous = active.value
  active.value = name
  switching.value = true
  try {
    await setTerminalBackend(name)
    message.success(t('settings.saved'))
    const list = await listTerminalBackends()
    backends.value = list.backends
    active.value = list.active
  } catch (err: any) {
    active.value = previous
    message.error(err?.message || t('settings.saveFailed'))
  } finally {
    switching.value = false
  }
}

async function saveSettings() {
  const changes = terminalChanges(fields.value, saved.value, form.value)
  if (!Object.keys(changes).length) return
  saving.value = true
  try {
    await updateConfigSection('terminal', changes)
    saved.value = { ...saved.value, ...changes }
    form.value = { ...saved.value }
    message.success(t('settings.saved'))
    backends.value = (await listTerminalBackends()).backends
  } catch (err: any) {
    message.error(err?.message || t('settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

function fieldLabel(key: string) {
  return te(`hermesTools.terminal.fields.${key}`) ? t(`hermesTools.terminal.fields.${key}`) : key
}
function fieldHint(key: string) {
  return te(`hermesTools.terminal.hints.${key}`) ? t(`hermesTools.terminal.hints.${key}`) : `terminal.${key}`
}
function numberValue(value: unknown): number | null {
  const n = Number(value)
  return value === '' || value === null || value === undefined || !Number.isFinite(n) ? null : n
}
function statusType(status: string) {
  return status === 'ready' ? 'success' : status === 'needs_setup' ? 'warning' : 'error'
}
function statusLabel(status: string) {
  return status === 'ready' ? t('hermesTools.terminal.ready') : status === 'needs_setup' ? t('hermesTools.terminal.needsSetup') : t('hermesTools.terminal.unavailable')
}

onMounted(load)
</script>

<template>
  <section class="settings-section">
    <div class="section-head">
      <div>
        <h3 class="section-title">{{ t('hermesTools.terminal.title') }}</h3>
        <p class="section-hint">{{ t('hermesTools.terminal.hint') }}</p>
      </div>
      <NButton size="small" :loading="loading" @click="load">{{ t('hermesTools.common.refresh') }}</NButton>
    </div>

    <NSpin :show="loading || switching">
      <p v-if="loadError" class="muted">{{ t('hermesTools.common.unavailable') }} {{ loadError }}</p>
      <NRadioGroup v-else :value="active" class="backend-list" @update:value="choose">
        <label v-for="backend in backends" :key="backend.name" class="backend-option" :class="{ active: backend.active }">
          <NRadio :value="backend.name" />
          <span class="backend-text">
            <span class="backend-name">{{ backend.label }}</span>
            <span class="muted">{{ backend.description }}</span>
            <span v-if="backend.detail" class="muted backend-detail">{{ backend.detail }}</span>
          </span>
          <NTag size="small" :type="statusType(backend.status)" :bordered="false">{{ statusLabel(backend.status) }}</NTag>
        </label>
      </NRadioGroup>
    </NSpin>
  </section>

  <section v-if="!loadError && !loading" class="settings-section">
    <h3 class="section-title">{{ t('hermesTools.terminal.settingsTitle', { backend: backends.find(b => b.name === active)?.label || active }) }}</h3>
    <p class="section-hint">{{ active === 'ssh' ? t('hermesTools.terminal.sshHint') : t('hermesTools.terminal.settingsHint') }}</p>
    <SettingRow v-for="field in fields" :key="field.key" :label="fieldLabel(field.key)" :hint="fieldHint(field.key)">
      <NSwitch v-if="field.type === 'switch'" :value="form[field.key] === true || form[field.key] === 'true'" @update:value="(v: boolean) => (form[field.key] = v)" />
      <NInputNumber
        v-else-if="field.type === 'number'"
        :value="numberValue(form[field.key])"
        :placeholder="field.placeholder"
        size="small"
        class="input-sm"
        clearable
        @update:value="(v: number | null) => (form[field.key] = v)"
      />
      <NInput v-else v-model:value="form[field.key]" :placeholder="field.placeholder" size="small" class="input-md" />
    </SettingRow>
    <div class="row-actions save-row">
      <NButton size="small" :disabled="!dirty" @click="form = { ...saved }">{{ t('hermesTools.common.reset') }}</NButton>
      <NButton size="small" type="primary" :disabled="!dirty" :loading="saving" @click="saveSettings">{{ t('hermesTools.common.save') }}</NButton>
    </div>
  </section>

  <section v-if="computerUse && computerUse.platform_supported" class="settings-section">
    <h3 class="section-title">{{ t('hermesTools.computerUse.title') }}</h3>
    <p class="section-hint">{{ t('hermesTools.computerUse.hint') }}</p>
    <SettingRow :label="t('hermesTools.computerUse.status')">
      <NTag size="small" :type="computerUse.installed && computerUse.ready !== false ? 'success' : 'warning'" :bordered="false">
        {{ computerUse.installed ? (computerUse.ready === false ? t('hermesTools.computerUse.needsPermission') : t('hermesTools.computerUse.installed', { version: computerUse.version || '' })) : t('hermesTools.computerUse.notInstalled') }}
      </NTag>
    </SettingRow>
    <p v-if="!computerUse.installed" class="muted">{{ t('hermesTools.computerUse.howToInstall') }}</p>
  </section>
</template>

<style scoped lang="scss">
@use './hermes-tools' as *;
@use '@/styles/variables' as vars;

.backend-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.backend-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: var(--border-width, 1px) solid vars.$border-light;
  border-radius: vars.$radius-sm;
  cursor: pointer;

  &.active {
    border-color: vars.$accent-primary;
  }
}

.backend-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.backend-name {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: vars.$text-primary;
}

.backend-detail {
  word-break: break-word;
}

.save-row {
  justify-content: flex-end;
  padding-top: 8px;
}
</style>
