<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { callOrbTool, fetchOrbData, type OrbChore } from '@/api/studio/orb'
import type { HerdrPaneView } from '@/api/coding-agents/herdr'
import LaunchButtons from '../LaunchButtons.vue'

/** Pondering Orb upkeep: UpstreamManager repos and approval requests, plus chores. */
const props = defineProps<{ panes: HerdrPaneView[]; workspace: string }>()
const emit = defineEmits<{ 'select-pane': [paneId: string] }>()
const { t } = useI18n()
const toast = useMessage()
const repos = ref<any[]>([])
const requests = ref<any[]>([])
const chores = ref<OrbChore[]>([])
const errors = ref<string[]>([])

function text(value: unknown): string {
  return value == null ? '' : String(value)
}

function repoName(repo: any): string {
  return text(repo.name || repo.repo || repo.full_name || repo.id)
}

async function load() {
  const problems: string[] = []
  const [r, q, c] = await Promise.allSettled([
    fetchOrbData<any[]>('upkeep-repos'),
    fetchOrbData<any[]>('upkeep-requests'),
    callOrbTool<OrbChore[]>('orb_list_chores'),
  ])
  if (r.status === 'fulfilled') repos.value = Array.isArray(r.value) ? r.value : []
  else problems.push(`${t('mission.upkeepRepos')}: ${r.reason?.message || r.reason}`)
  if (q.status === 'fulfilled') requests.value = Array.isArray(q.value) ? q.value : []
  else problems.push(`${t('mission.upkeepRequests')}: ${q.reason?.message || q.reason}`)
  if (c.status === 'fulfilled') chores.value = Array.isArray(c.value) ? c.value : []
  else problems.push(`${t('mission.chores')}: ${c.reason?.message || c.reason}`)
  errors.value = problems
}

async function choreDone(chore: OrbChore) {
  try {
    await callOrbTool('orb_chore_done', { name: chore.name })
    await load()
  } catch (err: any) {
    toast.error(err?.message || String(err))
  }
}

function promptForRepo(repo: any): string {
  return `My UpstreamManager reports this repository needs upkeep: ${repoName(repo)}. ${text(repo.status || repo.state)} Check it, sync it with upstream and fix what is needed.`
}

onMounted(load)
</script>

<template>
  <section class="source" data-testid="mission-source-upkeep">
    <div class="source-bar">
      <span>{{ t('mission.upkeepHint') }}</span>
      <span class="source-spacer" />
      <button type="button" class="source-link" @click="load">{{ t('mission.refresh') }}</button>
    </div>
    <p v-for="problem in errors" :key="problem" class="source-error">{{ problem }}</p>
    <div class="source-groups">
      <div class="source-group">
        <h4>{{ t('mission.upkeepRequests') }} <span>{{ requests.length }}</span></h4>
        <article v-for="(request, index) in requests" :key="text(request.id) || index" class="source-card" data-theme-surface="card">
          <span class="source-card-title">{{ text(request.title || request.summary || request.repo || request.id) }}</span>
          <div class="source-card-meta">
            <span v-if="request.repo" class="source-chip">{{ text(request.repo) }}</span>
            <span v-if="request.status" class="source-chip is-warn">{{ text(request.status) }}</span>
          </div>
        </article>
        <p v-if="!requests.length" class="source-empty">{{ t('mission.nothingWaiting') }}</p>
      </div>
      <div class="source-group">
        <h4>{{ t('mission.upkeepRepos') }} <span>{{ repos.length }}</span></h4>
        <article v-for="(repo, index) in repos" :key="text(repo.id) || index" class="source-card" data-theme-surface="card">
          <span class="source-card-title">{{ repoName(repo) }}</span>
          <div class="source-card-meta">
            <span v-if="repo.behind" class="source-chip is-warn">{{ t('mission.behind', { n: repo.behind }) }}</span>
            <span v-if="repo.status" class="source-chip">{{ text(repo.status) }}</span>
            <span v-if="repo.github" class="source-chip">{{ text(repo.github) }}</span>
          </div>
          <div class="source-card-actions">
            <LaunchButtons :card-key="`repo:${repoName(repo)}`" :title="repoName(repo)" :prompt="promptForRepo(repo)" :workspace="props.workspace || undefined" :panes="props.panes" @launched="pane => emit('select-pane', pane)" />
          </div>
        </article>
      </div>
      <div class="source-group">
        <h4>{{ t('mission.chores') }} <span>{{ chores.length }}</span></h4>
        <article v-for="chore in chores" :key="chore.name" class="source-card" data-theme-surface="card">
          <span class="source-card-title">{{ chore.name }}</span>
          <div class="source-card-meta">
            <span class="source-chip" :class="{ 'is-bad': (chore.daysLeft ?? 0) < 0, 'is-warn': (chore.daysLeft ?? 0) === 0 }">{{ t('mission.daysLeft', { n: chore.daysLeft ?? 0 }) }}</span>
            <span class="source-spacer" />
            <button type="button" class="source-link" @click="choreDone(chore)">{{ t('mission.done') }}</button>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use './source';
</style>
