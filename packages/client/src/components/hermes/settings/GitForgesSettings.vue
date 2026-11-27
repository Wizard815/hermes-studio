<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { NButton, NCheckbox, NInput, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchForgeSettings, saveForgeSettings, testForge, type ForgeSettingsView } from '@/api/studio/forge-settings'
import SettingRow from './SettingRow.vue'

/** Settings → Git forges (docs/forge.md): GitHub or the homelab forge, saved in the Hermes profile. */

const { t } = useI18n()
const toast = useMessage()
const view = ref<ForgeSettingsView | null>(null)
const loadError = ref('')
const busy = ref('')
const testResult = ref('')
const testError = ref('')
const draft = reactive({ url: '', hosts: '', defaultHome: '', githubOwner: '', jobsRepo: '', token: '', clearToken: false })

const homeOptions = () => [
  { label: t('gitForges.homeAsk'), value: '' },
  { label: t('gitForges.homeForge'), value: 'forge' },
  { label: t('gitForges.homeGithub'), value: 'github' },
]

function fill(next: ForgeSettingsView) {
  view.value = next
  Object.assign(draft, { url: next.url, hosts: next.hosts.join(', '), defaultHome: next.defaultHome, githubOwner: next.githubOwner, jobsRepo: next.jobsRepo, token: '', clearToken: false })
}

async function load() {
  try { fill(await fetchForgeSettings()); loadError.value = '' } catch (error) { loadError.value = (error as Error).message }
}

async function save() {
  busy.value = 'save'
  try {
    fill(await saveForgeSettings({ ...draft }))
    toast.success(t('gitForges.saved'))
  } catch (error) { toast.error((error as Error).message) } finally { busy.value = '' }
}

async function test() {
  busy.value = 'test'
  testResult.value = ''
  testError.value = ''
  try {
    const out = await testForge({ url: draft.url, token: draft.token })
    testResult.value = t('gitForges.testOk', { url: out.url, login: out.login, version: out.version || '?' })
  } catch (error) { testError.value = (error as Error).message } finally { busy.value = '' }
}

onMounted(load)
</script>

<template>
  <section class="settings-section git-forges" data-testid="git-forges-settings">
    <h3 class="section-title">{{ t('gitForges.tab') }}</h3>
    <p v-if="loadError" class="forge-error" role="alert">{{ t('gitForges.loadFailed', { error: loadError }) }}</p>
    <template v-else-if="view">
      <p class="section-hint">{{ t('gitForges.intro', { profile: view.profile }) }}</p>

      <SettingRow :label="t('gitForges.github')">
        <span class="forge-status" :data-state="view.github.tokenSet ? 'ok' : 'off'" role="status">
          {{ view.github.tokenSet ? t('gitForges.githubOk') : t('gitForges.githubMissing') }}
        </span>
      </SettingRow>

      <p v-if="view.source === 'host'" class="forge-note" role="note">{{ t('gitForges.hostWins', { url: view.hostUrl }) }}</p>

      <SettingRow :label="t('gitForges.url')" :hint="t('gitForges.urlHint')">
        <NInput v-model:value="draft.url" size="small" class="input-lg" placeholder="http://192.168.20.5:3030" :input-props="{ 'aria-label': t('gitForges.url') }" />
      </SettingRow>
      <SettingRow :label="t('gitForges.hosts')" :hint="t('gitForges.hostsHint')">
        <NInput v-model:value="draft.hosts" size="small" class="input-lg" placeholder="Forgejo:3000" :input-props="{ 'aria-label': t('gitForges.hosts') }" />
      </SettingRow>
      <SettingRow :label="t('gitForges.token')" :hint="view.tokenSet ? t('gitForges.tokenSaved') : t('gitForges.tokenHint')">
        <div class="forge-token">
          <NInput v-model:value="draft.token" type="password" show-password-on="click" size="small" class="input-lg" autocomplete="off" :input-props="{ 'aria-label': t('gitForges.token') }" />
          <NCheckbox v-if="view.tokenSet" v-model:checked="draft.clearToken">{{ t('gitForges.clearToken') }}</NCheckbox>
        </div>
      </SettingRow>
      <SettingRow :label="t('gitForges.defaultHome')" :hint="t('gitForges.defaultHomeHint')">
        <NSelect v-model:value="draft.defaultHome" size="small" class="input-lg" :options="homeOptions()" :aria-label="t('gitForges.defaultHome')" />
      </SettingRow>
      <SettingRow :label="t('gitForges.githubOwner')" :hint="t('gitForges.githubOwnerHint')">
        <NInput v-model:value="draft.githubOwner" size="small" class="input-lg" placeholder="Wizard815" :input-props="{ 'aria-label': t('gitForges.githubOwner') }" />
      </SettingRow>
      <SettingRow :label="t('gitForges.jobsRepo')" :hint="t('gitForges.jobsRepoHint')">
        <NInput v-model:value="draft.jobsRepo" size="small" class="input-lg" placeholder="wizard/hermes-jobs" :input-props="{ 'aria-label': t('gitForges.jobsRepo') }" />
      </SettingRow>

      <p v-if="testResult" class="forge-ok" role="status" data-testid="git-forges-test-ok">{{ testResult }}</p>
      <p v-if="testError" class="forge-error" role="alert">{{ testError }}</p>

      <div class="settings-actions">
        <NButton secondary :loading="busy === 'test'" data-testid="git-forges-test" @click="test">{{ t('gitForges.test') }}</NButton>
        <NButton type="primary" :loading="busy === 'save'" data-testid="git-forges-save" @click="save">{{ t('gitForges.save') }}</NButton>
      </div>
    </template>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section { width: 100%; max-width: none; }
.section-title { margin: 0 0 6px; font-size: calc(var(--font-size-base, 14px) * 18 / 14); }
.section-hint { margin: 0 0 16px; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 13 / 14); }
.input-lg { width: 100%; }
.git-forges :deep(.setting-info), .git-forges :deep(.setting-control) { min-width: 0; flex: 1; }
.forge-token { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.forge-status { font-size: calc(var(--font-size-base, 14px) * 13 / 14); color: $text-secondary; &[data-state="ok"] { color: $success; } }
.forge-note { margin: 8px 0; color: $warning; }
.forge-ok { margin: 8px 0 0; color: $success; }
.forge-error { margin: 8px 0 0; color: $error; }
.settings-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: calc(16px * var(--spacing-scale, 1)); }
</style>
