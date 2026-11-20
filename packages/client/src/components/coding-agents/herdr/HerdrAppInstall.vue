<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { downloadHerdrAppLayoutScript } from '@/api/coding-agents/herdr'
import { useHerdrStore } from '@/stores/hermes/herdr'

/**
 * herdr settings: put the same Space Folders layout in the Herdr desktop app
 * (scripts/install-herdr-app-layout.sh). It links herdr-space-folders' mod,
 * copies its main-folders layout and merges its keys; Herdr App then shares
 * Studio's folders through ~/.config/herdr-space-folders.json.
 */
const { t } = useI18n()
const toast = useMessage()
const herdr = useHerdrStore()
const script = computed(() => herdr.status?.appLayoutScript || '')
const command = computed(() => `bash ${script.value ? `"${script.value}"` : 'install-herdr-app-layout.sh'} --switch`)
const busy = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(command.value)
    toast.success(t('herdrApp.install.copied'))
  } catch {
    toast.info(command.value)
  }
}

async function download() {
  busy.value = true
  try {
    const blob = await downloadHerdrAppLayoutScript()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'install-herdr-app-layout.sh'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="hai" data-testid="herdr-app-install">
    <h4>{{ t('herdrApp.install.title') }}</h4>
    <p class="hai-hint">{{ t('herdrApp.install.hint') }}</p>
    <code class="hai-command" data-testid="herdr-app-install-command">{{ command }}</code>
    <div class="hai-actions">
      <NButton size="small" data-testid="herdr-app-install-copy" @click="copy">{{ t('herdrApp.install.copy') }}</NButton>
      <NButton size="small" :loading="busy" data-testid="herdr-app-install-download" @click="download">{{ t('herdrApp.install.download') }}</NButton>
    </div>
    <p class="hai-hint">{{ t('herdrApp.install.remote') }}</p>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.hai {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;

  h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: $text-primary;
  }
}

.hai-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: $text-muted;
}

.hai-command {
  display: block;
  padding: 6px 8px;
  overflow-x: auto;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
  background: var(--theme-input-bg, $bg-input);
  color: $text-primary;
  font-family: $font-code;
  font-size: 12px;
  white-space: pre;
}

.hai-actions {
  display: flex;
  gap: 6px;
}
</style>
