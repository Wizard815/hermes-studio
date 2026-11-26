<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import { closeHerdrSessionPane } from '@/api/coding-agents/herdr'
import { fetchAgentDetails, type AgentContext } from '@/api/studio/command-center'
import { studioUrl } from '../useMission'
import { useCommandCenter } from './useCommandCenter'
import { contextMeter, folderName, formatAge, formatTokens, type LiveAgent } from './model'
import PlanBars from './PlanBars.vue'

/**
 * Agents (Roundup's agent cards with Command Center's status): one card per
 * running or recent agent, with its model, folder and branch, a context meter
 * from Studio's usage records, time in its state and what you can do.
 */
const emit = defineEmits<{ 'select-pane': [paneId: string] }>()
const { t } = useI18n()
const toast = useMessage()
const dialog = useDialog()
const cc = useCommandCenter()
const contexts = ref<Record<string, AgentContext>>({})
const branches = ref<Record<string, string>>({})
const filter = ref<'all' | 'active'>('all')
let timer = 0

const agents = computed(() => cc.agents.value.filter(agent => filter.value === 'all' || agent.status === 'working' || agent.status === 'blocked'))
const pendingWork = computed(() => new Map(cc.state.work.filter(work => work.status === 'awaiting_approval' && work.sessionId).map(work => [work.sessionId, work])))
const codexLimits = computed(() => cc.state.limits.find(limit => limit.agent === 'codex') || null)

async function loadDetails() {
  const list = cc.agents.value
  const sessions = list.map(agent => agent.sessionId).filter((id): id is string => !!id)
  const folders = [...new Set(list.map(agent => agent.cwd).filter(Boolean))]
  if (!sessions.length && !folders.length) return
  try {
    const result = await fetchAgentDetails({ sessions, folders })
    contexts.value = result.contexts
    branches.value = result.branches
  } catch { /* the cards show what herdr and Studio know */ }
}

// A different set of agents or folders: fetch again (not on every status change).
watch(() => cc.agents.value.map(agent => `${agent.key}|${agent.cwd}`).join(','), () => { void loadDetails() })

function context(agent: LiveAgent) {
  return agent.sessionId ? contexts.value[agent.sessionId] : undefined
}
function meter(agent: LiveAgent) {
  const value = context(agent)
  return contextMeter(value?.contextTokens, value?.contextWindow)
}
function since(agent: LiveAgent) {
  return formatAge(cc.state.since[agent.key]?.since || 0, cc.state.now)
}
function studioChat(agent: LiveAgent) {
  return agent.sessionId ? studioUrl(`/hermes/session/${agent.sessionId}?center=chat`) : null
}
function isCodex(agent: LiveAgent) {
  return /codex/i.test(agent.agent)
}

function stop(agent: LiveAgent) {
  if (!agent.sessionId) return
  dialog.warning({
    title: t('commandCenter.agents.stopTitle'),
    content: t('commandCenter.agents.stopBody', { title: agent.title }),
    positiveText: t('commandCenter.agents.stop'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await closeHerdrSessionPane(agent.sessionId!)
        toast.success(t('commandCenter.agents.stopped'))
      } catch (err: any) { toast.error(err?.message || String(err)) }
    },
  })
}

async function decide(workId: string, decision: 'approve' | 'reject') {
  try { await cc.decide(workId, decision) } catch (err: any) { toast.error(err?.message || String(err)) }
}

onMounted(() => {
  void loadDetails()
  timer = window.setInterval(() => { void loadDetails() }, 30_000)
})
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <section class="source cc-agents" data-testid="cc-agents">
    <div class="source-bar">
      <div class="cc-seg" role="radiogroup" :aria-label="t('commandCenter.agents.filter')">
        <button type="button" role="radio" :aria-checked="filter === 'all'" :class="{ active: filter === 'all' }" @click="filter = 'all'">{{ t('commandCenter.agents.all', { n: cc.agents.value.length }) }}</button>
        <button type="button" role="radio" :aria-checked="filter === 'active'" :class="{ active: filter === 'active' }" @click="filter = 'active'">{{ t('commandCenter.agents.active') }}</button>
      </div>
      <span class="source-spacer" />
      <NButton size="tiny" quaternary @click="loadDetails">{{ t('mission.refresh') }}</NButton>
    </div>
    <p v-if="!agents.length" class="source-empty">{{ t('commandCenter.agents.empty') }}</p>
    <article v-for="agent in agents" :key="agent.key" class="source-card cc-agent" :class="`is-${agent.status}`" data-theme-surface="card" :data-testid="`cc-agent-${agent.status}`">
      <div class="source-card-meta">
        <AgentStatusIcon :status="agent.status" :live="agent.live" :size="13" />
        <span class="cc-state">{{ t(`agentStatus.${agent.status}`) }}</span>
        <span v-if="since(agent)" :title="t('commandCenter.agents.inState')">· {{ since(agent) }}</span>
        <span class="source-spacer" />
        <span v-if="agent.paneId" class="cc-pane">{{ agent.paneId }}</span>
      </div>
      <div class="source-card-title">{{ agent.title }}</div>
      <div class="source-card-meta">
        <span v-if="agent.agent" class="source-chip">{{ agent.agent }}</span>
        <span v-if="context(agent)?.model" class="source-chip" :title="context(agent)?.provider">{{ context(agent)?.model }}</span>
        <span v-if="agent.waiting" class="source-chip">{{ t('commandCenter.agents.waiting') }}</span>
      </div>
      <div v-if="agent.cwd" class="source-card-meta cc-where" :title="agent.cwd">
        <span class="cc-folder">{{ folderName(agent.cwd) }}</span>
        <span v-if="branches[agent.cwd]" class="source-chip">⎇ {{ branches[agent.cwd] }}</span>
      </div>
      <div v-if="context(agent)" class="cc-meter" :class="`is-${meter(agent).level}`" data-testid="cc-agent-context">
        <div class="cc-meter-label">
          <span>{{ t('commandCenter.agents.context') }}</span>
          <span v-if="meter(agent).percent != null">{{ formatTokens(context(agent)?.contextTokens) }} / {{ formatTokens(context(agent)?.contextWindow) }} · {{ meter(agent).percent }}%</span>
          <span v-else>{{ t('commandCenter.agents.contextUnknown') }}</span>
        </div>
        <div class="cc-bar" role="meter" :aria-valuenow="meter(agent).percent ?? 0" aria-valuemin="0" aria-valuemax="100" :aria-label="t('commandCenter.agents.context')">
          <span :style="{ width: `${meter(agent).percent ?? 0}%` }" />
        </div>
        <div class="cc-tokens">{{ t('commandCenter.agents.tokens', { input: formatTokens(context(agent)?.inputTokens), output: formatTokens(context(agent)?.outputTokens) }) }}</div>
      </div>
      <PlanBars v-if="isCodex(agent) && codexLimits" :limits="codexLimits" compact />
      <div class="source-card-actions">
        <template v-if="agent.sessionId && pendingWork.get(agent.sessionId)">
          <NButton size="tiny" type="primary" @click="decide(pendingWork.get(agent.sessionId)!.id, 'approve')">{{ t('agentWork.approve') }}</NButton>
          <NButton size="tiny" @click="decide(pendingWork.get(agent.sessionId)!.id, 'reject')">{{ t('agentWork.reject') }}</NButton>
        </template>
        <NButton v-if="agent.paneId" size="tiny" @click="emit('select-pane', agent.paneId)">{{ t('mission.showPane') }}</NButton>
        <a v-if="studioChat(agent)" class="source-link" :href="studioChat(agent)!">{{ t('mission.openInStudio') }}</a>
        <span class="source-spacer" />
        <NButton v-if="agent.live && agent.sessionId && !agent.waiting" size="tiny" quaternary type="error" data-testid="cc-agent-stop" @click="stop(agent)">{{ t('commandCenter.agents.stop') }}</NButton>
      </div>
    </article>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '../sources/source';
@use './command-center';

.cc-agent {
  border-left-width: 3px;

  &.is-blocked { border-left-color: $warning; }
  &.is-working { border-left-color: $accent-primary; }
  &.is-done { border-left-color: $success; }
}

.cc-state {
  font-weight: 600;
  color: $text-secondary;
}

.cc-pane {
  font-family: $font-code;
  font-size: 10.5px;
}

.cc-where span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cc-tokens {
  font-size: 10.5px;
  color: $text-muted;
}
</style>
