<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NButton, NInput, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { installHerdrIntegrations, installHerdrStudioPlugin } from '@/api/coding-agents/herdr'
import { useHerdrStore } from '@/stores/hermes/herdr'

const { t } = useI18n()
const toast = useMessage()
const herdr = useHerdrStore()
const saving = ref(false)
const installing = ref(false)
const starting = ref(false)
const installingPlugin = ref(false)
const form = reactive({ binaryPath: '', session: '', profile: 'default' })

watch(() => herdr.status?.settings, settings => {
  if (!settings) return
  form.binaryPath = settings.binaryPath
  form.session = settings.session
  form.profile = settings.profile
}, { immediate: true })

const settings = computed(() => herdr.status?.settings)
const serverRunning = computed(() => herdr.status?.server?.running === true)

async function save(patch: Record<string, unknown>) {
  saving.value = true
  try {
    await herdr.updateSettings(patch)
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    saving.value = false
  }
}

async function installIntegrations() {
  installing.value = true
  try {
    const { results } = await installHerdrIntegrations()
    const failed = results.filter(result => !result.ok)
    if (failed.length) toast.warning(t('herdr.settings.integrationsPartial', { failed: failed.map(f => f.kind).join(', ') }))
    else toast.success(t('herdr.settings.integrationsInstalled'))
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    installing.value = false
  }
}

async function installPlugin() {
  installingPlugin.value = true
  try {
    const result = await installHerdrStudioPlugin()
    if (result.linked) toast.success(t('herdr.settings.pluginInstalled'))
    else toast.warning(result.message)
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    installingPlugin.value = false
  }
}

async function startServer() {
  starting.value = true
  try { await herdr.startServer() } catch (err: any) { toast.error(err?.message || String(err)) } finally { starting.value = false }
}
</script>

<template>
  <section class="herdr-settings" data-theme-surface="card" data-testid="herdr-settings">
    <header class="herdr-settings-head">
      <h3>{{ t('herdr.settings.title') }}</h3>
      <p>{{ t('herdr.settings.description') }}</p>
    </header>

    <div class="herdr-settings-facts">
      <span>{{ t('herdr.settings.binary') }}: <code>{{ herdr.status?.binary || t('herdr.settings.notFound') }}</code></span>
      <span>{{ t('herdr.settings.version') }}: <code>{{ herdr.status?.version || '—' }}</code></span>
      <span>{{ t('herdr.settings.server') }}: <code>{{ serverRunning ? t('herdr.settings.running') : t('herdr.settings.stopped') }}</code></span>
    </div>

    <label class="herdr-settings-row">
      <span>{{ t('herdr.settings.enabled') }}</span>
      <NSwitch
        :value="settings?.enabled === true"
        :loading="saving"
        :disabled="!herdr.status?.installed && !settings?.enabled"
        data-testid="herdr-enable"
        @update:value="value => save({ enabled: value })"
      />
    </label>
    <label class="herdr-settings-row">
      <span>{{ t('herdr.settings.autoImport') }}</span>
      <NSwitch :value="settings?.autoImport !== false" @update:value="value => save({ autoImport: value })" />
    </label>
    <label class="herdr-settings-row">
      <span>{{ t('herdr.settings.mirror') }}</span>
      <NSwitch :value="settings?.mirrorTranscripts !== false" @update:value="value => save({ mirrorTranscripts: value })" />
    </label>

    <div class="herdr-settings-grid">
      <label>
        <span>{{ t('herdr.settings.binaryPath') }}</span>
        <NInput v-model:value="form.binaryPath" :placeholder="t('herdr.settings.binaryPathPlaceholder')" size="small" />
      </label>
      <label>
        <span>{{ t('herdr.settings.session') }}</span>
        <NInput v-model:value="form.session" placeholder="default" size="small" />
      </label>
      <label>
        <span>{{ t('herdr.settings.profile') }}</span>
        <NInput v-model:value="form.profile" placeholder="default" size="small" />
      </label>
    </div>

    <div class="herdr-settings-actions">
      <NButton size="small" type="primary" :loading="saving" @click="save({ ...form })">{{ t('common.save') }}</NButton>
      <NButton size="small" :loading="starting" :disabled="!herdr.status?.installed || serverRunning" @click="startServer">
        {{ t('herdr.settings.startServer') }}
      </NButton>
      <NButton size="small" :loading="installing" :disabled="!herdr.status?.installed" @click="installIntegrations">
        {{ t('herdr.settings.installIntegrations') }}
      </NButton>
    </div>
    <p class="herdr-settings-hint">{{ t('herdr.settings.integrationsHint') }}</p>
    <div class="herdr-settings-actions">
      <NButton size="small" :loading="installingPlugin" :disabled="!herdr.status?.installed || !settings?.enabled" data-testid="herdr-install-plugin" @click="installPlugin">
        {{ t('herdr.settings.installPlugin') }}
      </NButton>
    </div>
    <p class="herdr-settings-hint">{{ t('herdr.settings.pluginHint') }}</p>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.herdr-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
}

.herdr-settings-head h3 {
  margin: 0 0 4px;
  font-size: 15px;
}

.herdr-settings-head p,
.herdr-settings-hint {
  margin: 0;
  color: $text-secondary;
  font-size: 12px;
}

.herdr-settings-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: $text-secondary;

  code {
    color: $text-primary;
    word-break: break-all;
  }
}

.herdr-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.herdr-settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;

  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: $text-secondary;
  }
}

.herdr-settings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
