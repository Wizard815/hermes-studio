<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NCheckbox, NInput, NModal, NSelect, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchGithubRepos, packRepo, packedRepoFile, type GithubRepoSummary } from '@/api/studio/repo-pack'

/**
 * Add a repo to a chat (docs/repo-pack.md): pick one of your GitHub repos or
 * paste a link; Studio packs it with repomix and the packed Markdown file is
 * attached to the message like any upload.
 */
defineProps<{ mobile?: boolean }>()
const emit = defineEmits<{ attach: [file: File] }>()
const { t } = useI18n()

const open = ref(false)
const repo = ref('')
const ref_ = ref('')
const include = ref('')
const compress = ref(true)
const busy = ref(false)
const error = ref('')
const repos = ref<GithubRepoSummary[]>([])
const connected = ref<boolean | null>(null)

const repoOptions = computed(() => repos.value.map(item => ({ label: `${item.fullName}${item.private ? ' 🔒' : ''}`, value: item.fullName })))

async function show() {
  open.value = true
  error.value = ''
  if (connected.value !== null) return
  try {
    const result = await fetchGithubRepos()
    connected.value = result.connected
    repos.value = result.repos
  } catch {
    connected.value = false
  }
}

async function pack() {
  if (!repo.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    const result = await packRepo({ repo: repo.value.trim(), ref: ref_.value.trim() || undefined, include: include.value.trim() || undefined, compress: compress.value })
    emit('attach', packedRepoFile(result))
    open.value = false
    repo.value = ''
    ref_.value = ''
    include.value = ''
  } catch (err: any) {
    error.value = err?.message || t('repoPack.failed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <NTooltip trigger="hover" :disabled="mobile">
    <template #trigger>
      <NButton quaternary size="tiny" circle class="toolbar-icon-button" :aria-label="t('repoPack.button')" data-testid="repo-pack-button" @click="show">
        <template #icon>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-11 5.5"/></svg>
        </template>
      </NButton>
    </template>
    {{ t('repoPack.button') }}
  </NTooltip>

  <NModal v-model:show="open" preset="card" :title="t('repoPack.title')" :style="{ width: 'min(560px, calc(100vw - 32px))' }">
    <form class="repo-pack" data-testid="repo-pack-form" @submit.prevent="pack">
      <p class="hint">{{ t('repoPack.intro') }}</p>
      <label v-if="connected" class="field">
        <span class="label">{{ t('repoPack.yourRepos') }}</span>
        <NSelect :value="null" :options="repoOptions" filterable :placeholder="t('repoPack.pickRepo')" size="small" @update:value="(value: string) => { repo = value }" />
      </label>
      <p v-else-if="connected === false" class="hint">{{ t('repoPack.noToken') }}</p>
      <label class="field">
        <span class="label">{{ t('repoPack.repo') }}</span>
        <NInput v-model:value="repo" size="small" placeholder="owner/name or https://github.com/owner/name" :input-props="{ 'aria-label': t('repoPack.repo') }" />
      </label>
      <label class="field">
        <span class="label">{{ t('repoPack.ref') }}</span>
        <NInput v-model:value="ref_" size="small" :placeholder="t('repoPack.refHint')" :input-props="{ 'aria-label': t('repoPack.ref') }" />
      </label>
      <label class="field">
        <span class="label">{{ t('repoPack.include') }}</span>
        <NInput v-model:value="include" size="small" placeholder="src/**,docs/**" :input-props="{ 'aria-label': t('repoPack.include') }" />
      </label>
      <NCheckbox v-model:checked="compress">{{ t('repoPack.compress') }}</NCheckbox>
      <NAlert v-if="error" type="error" :bordered="false" role="status">{{ error }}</NAlert>
      <p v-if="busy" class="hint" role="status" aria-live="polite">{{ t('repoPack.packing') }}</p>
      <div class="actions">
        <NButton @click="open = false">{{ t('repoPack.cancel') }}</NButton>
        <NButton type="primary" attr-type="submit" :loading="busy" :disabled="!repo.trim()">{{ t('repoPack.pack') }}</NButton>
      </div>
    </form>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.repo-pack { display: flex; flex-direction: column; gap: calc(12px * var(--spacing-scale, 1)); }
.field { display: flex; flex-direction: column; gap: 4px; }
.label { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.hint { margin: 0; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 13 / 14); }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
