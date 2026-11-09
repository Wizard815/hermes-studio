<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchOrbStatus, saveOrbSettings, type OrbStatus } from '@/api/studio/orb'

/** Pondering Orb's address and API token (optional; Mission's Orb sources use it). */
const { t } = useI18n()
const toast = useMessage()
const orb = ref<OrbStatus | null>(null)
const url = ref('')
const token = ref('')
const saving = ref(false)

async function load() {
  try {
    orb.value = await fetchOrbStatus()
    url.value = orb.value.settings.url
  } catch { orb.value = null }
}

async function save() {
  saving.value = true
  try {
    await saveOrbSettings({ url: url.value.trim(), ...(token.value.trim() ? { token: token.value.trim() } : {}) })
    token.value = ''
    await load()
    toast.success(orb.value?.connected ? t('mission.orbConnected') : t('mission.orbSaved'))
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="herdr-orb" data-testid="herdr-orb-settings">
    <header class="herdr-orb-head">
      <h4>{{ t('herdr.settings.orbTitle') }}</h4>
      <span class="herdr-orb-state" :class="{ 'is-good': orb?.connected }">
        {{ orb?.connected ? t('mission.connected', { version: orb.version }) : t('mission.notConnected') }}
      </span>
    </header>
    <p class="herdr-orb-hint">{{ t('herdr.settings.orbOptional') }}</p>
    <template v-if="!orb?.settings.fromEnv">
      <div class="herdr-orb-form">
        <NInput v-model:value="url" size="small" placeholder="http://pondering-orb:8080" data-testid="herdr-orb-url" />
        <NInput v-model:value="token" size="small" type="password" :placeholder="orb?.settings.hasToken ? t('mission.tokenKept') : t('mission.orbToken')" data-testid="herdr-orb-token" />
        <NButton size="small" type="primary" :loading="saving" data-testid="herdr-orb-save" @click="save">{{ t('mission.connect') }}</NButton>
      </div>
      <p v-if="orb?.error && orb.settings.url" class="herdr-orb-error">{{ orb.error }}</p>
    </template>
    <p v-else class="herdr-orb-hint">{{ t('mission.orbFromEnv') }}</p>
    <p class="herdr-orb-hint">{{ t('mission.orbHint') }}</p>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.herdr-orb {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: var(--border-width, 1px) solid $border-light;
}

.herdr-orb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  h4 {
    margin: 0;
    font-size: 14px;
  }
}

.herdr-orb-state {
  font-size: 12px;
  color: $text-muted;

  &.is-good {
    color: $success;
  }
}

.herdr-orb-hint,
.herdr-orb-error {
  margin: 0;
  font-size: 12px;
  color: $text-muted;
}

.herdr-orb-error {
  color: $error;
}

.herdr-orb-form {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto;
  gap: 8px;
}

@media (max-width: 640px) {
  .herdr-orb-form {
    grid-template-columns: 1fr;
  }
}
</style>
