<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NCheckbox, NInput, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { isStoredSuperAdmin } from '@/api/client'
import {
  decideAgentWork, fetchAgentActivity, fetchAgentWork, fetchAgentWorkSettings, saveAgentWorkSettings, writeAgentWorkDigest,
  type AgentActivity, type AgentWork, type AgentWorkSettings,
} from '@/api/studio/agent-work'
import { refreshAgentWorkBadge } from '@/composables/useAgentWorkBadge'

/**
 * Connections → Agent work: work agents do on Vikunja tasks, approvals (which
 * can also be given in Mattermost and Pondering Orb; the first one wins
 * everywhere), the activity log, and where it all goes.
 */
const { t } = useI18n()
const toast = useMessage()
const router = useRouter()
const canConfigure = isStoredSuperAdmin()

const work = ref<AgentWork[]>([])
const activity = ref<AgentActivity[]>([])
const deciding = ref('')
const settings = ref<AgentWorkSettings | null>(null)
const form = ref({ channel: '', mention: '', mentionOnApproval: true, actionUrl: '', shareToOrb: false, allglanceUrl: '', allglanceToken: '', wikiUrl: '', wikiToken: '', wikiFolder: 'daily', wikiSection: 'Hermes Studio' })
const saving = ref(false)
const digesting = ref(false)
let timer = 0

const waiting = computed(() => work.value.filter(w => w.status === 'awaiting_approval'))
const others = computed(() => work.value.filter(w => w.status !== 'awaiting_approval'))
const titles = computed(() => new Map(work.value.map(w => [w.id, w.title])))

async function load() {
  try { work.value = (await fetchAgentWork()).work } catch { work.value = [] }
  try { activity.value = (await fetchAgentActivity(60)).activity } catch { activity.value = [] }
}

async function loadSettings() {
  if (!canConfigure) return
  try {
    const s = await fetchAgentWorkSettings()
    settings.value = s
    form.value = {
      channel: s.mattermost.channel, mention: s.mattermost.mention.join(', '), mentionOnApproval: s.mattermost.mentionOnApproval,
      actionUrl: s.mattermost.actionUrl, shareToOrb: s.shareToOrb, allglanceUrl: s.allglance.url, allglanceToken: '',
      wikiUrl: s.wiki.url, wikiToken: '', wikiFolder: s.wiki.folder, wikiSection: s.wiki.section,
    }
  } catch { settings.value = null }
}

async function decide(item: AgentWork, decision: 'approve' | 'reject') {
  deciding.value = item.id
  try {
    const result = await decideAgentWork(item.id, decision)
    if (result.changed) toast.success(result.message)
    else toast.info(result.message)
    await load()
    refreshAgentWorkBadge()
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    deciding.value = ''
  }
}

async function save() {
  saving.value = true
  try {
    const f = form.value
    await saveAgentWorkSettings({
      shareToOrb: f.shareToOrb,
      mattermost: { channel: f.channel.trim(), mention: f.mention.trim(), mentionOnApproval: f.mentionOnApproval, actionUrl: f.actionUrl.trim() },
      ...(settings.value?.allglance.fromEnv ? {} : { allglance: { url: f.allglanceUrl.trim(), ...(f.allglanceToken.trim() ? { token: f.allglanceToken.trim() } : {}) } }),
      wiki: { url: f.wikiUrl.trim(), folder: f.wikiFolder.trim(), section: f.wikiSection.trim(), ...(f.wikiToken.trim() ? { token: f.wikiToken.trim() } : {}) },
    })
    toast.success(t('agentWork.saved'))
    await loadSettings()
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    saving.value = false
  }
}

async function digestNow() {
  digesting.value = true
  try {
    const result = await writeAgentWorkDigest()
    if (result.written) toast.success(t('agentWork.digestWritten', { path: result.path }))
    else toast.info(t('agentWork.digestNotSet'))
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    digesting.value = false
  }
}

function openChat(item: AgentWork) {
  if (item.sessionId) void router.push({ name: 'hermes.session', params: { sessionId: item.sessionId } })
}

const when = (at: number) => (at ? new Date(at).toLocaleString() : '')

onMounted(() => {
  void load()
  void loadSettings()
  timer = window.setInterval(() => { void load() }, 10000)
})
onBeforeUnmount(() => { if (timer) window.clearInterval(timer) })
</script>

<template>
  <div class="agent-work" data-testid="agent-work">
    <section class="aw-card" data-theme-surface="card">
      <header class="aw-head"><h3>{{ t('agentWork.waitingTitle') }}</h3><span v-if="waiting.length" class="aw-count" data-testid="agent-work-waiting-count">{{ waiting.length }}</span></header>
      <p v-if="!waiting.length" class="aw-hint" data-testid="agent-work-waiting-empty">{{ t('agentWork.waitingEmpty') }}</p>
      <div v-for="item in waiting" :key="item.id" class="aw-item" data-testid="agent-work-waiting">
        <div class="aw-main">
          <span class="aw-status" data-status="awaiting_approval">{{ t('agentWork.status.awaiting_approval') }}</span>
          <b class="aw-title">{{ item.title }}</b>
          <span class="aw-meta">
            <template v-if="item.vikunjaTaskId">{{ t('agentWork.vikunjaTask', { id: item.vikunjaTaskId }) }} · </template>{{ item.agent }}
          </span>
          <p v-if="item.summary" class="aw-summary">{{ item.summary }}</p>
        </div>
        <div class="aw-actions">
          <NButton size="small" type="primary" :loading="deciding === item.id" data-testid="agent-work-approve" @click="decide(item, 'approve')">{{ t('agentWork.approve') }}</NButton>
          <NButton size="small" :disabled="deciding === item.id" data-testid="agent-work-reject" @click="decide(item, 'reject')">{{ t('agentWork.reject') }}</NButton>
        </div>
      </div>
    </section>

    <section class="aw-card" data-theme-surface="card">
      <header class="aw-head"><h3>{{ t('agentWork.recentTitle') }}</h3></header>
      <p v-if="!others.length" class="aw-hint">{{ t('agentWork.recentEmpty') }}</p>
      <button v-for="item in others" :key="item.id" type="button" class="aw-item aw-row" data-testid="agent-work-item" @click="openChat(item)">
        <span class="aw-status" :data-status="item.status">{{ t(`agentWork.status.${item.status}`) }}</span>
        <span class="aw-title">{{ item.title }}</span>
        <span class="aw-meta">
          <template v-if="item.vikunjaTaskId">{{ t('agentWork.vikunjaTask', { id: item.vikunjaTaskId }) }} · </template>
          <template v-if="item.decision">{{ t('agentWork.decided', { decision: t(`agentWork.status.${item.decision === 'approved' ? 'done' : 'rejected'}`), via: t(`agentWork.via.${item.decidedVia}`) }) }}</template>
          <template v-else>{{ item.agent }}</template>
          <template v-if="item.decision === 'approved' && item.vikunjaTaskId">
            · {{ item.vikunjaDoneAt ? t('agentWork.vikunjaDone') : t('agentWork.vikunjaPending', { error: item.vikunjaError }) }}
          </template>
        </span>
      </button>
    </section>

    <section class="aw-card" data-theme-surface="card">
      <header class="aw-head"><h3>{{ t('agentWork.activityTitle') }}</h3></header>
      <ul class="aw-activity">
        <li v-for="entry in activity" :key="entry.id">
          <span class="aw-when">{{ when(entry.at) }}</span>
          <b>{{ titles.get(entry.workId) || entry.workId.slice(0, 8) }}</b>
          <span class="aw-kind">{{ entry.kind }}</span>
          <span>{{ entry.message }}</span>
        </li>
      </ul>
    </section>

    <section v-if="canConfigure && settings" class="aw-card" data-theme-surface="card" data-testid="agent-work-settings">
      <header class="aw-head"><h3>{{ t('agentWork.settingsTitle') }}</h3></header>

      <h4>{{ t('agentWork.mattermostTitle') }}</h4>
      <label class="aw-field">{{ t('agentWork.channel') }}
        <NInput v-model:value="form.channel" size="small" placeholder="hermes" data-testid="agent-work-channel" />
      </label>
      <p class="aw-hint">{{ t('agentWork.channelHint') }}</p>
      <label class="aw-field">{{ t('agentWork.mention') }}
        <NInput v-model:value="form.mention" size="small" placeholder="" data-testid="agent-work-mention" />
      </label>
      <p class="aw-hint">{{ t('agentWork.mentionHint') }}</p>
      <NCheckbox v-model:checked="form.mentionOnApproval">{{ t('agentWork.mentionOnApproval') }}</NCheckbox>
      <label class="aw-field">{{ t('agentWork.actionUrl') }}
        <NInput v-model:value="form.actionUrl" size="small" placeholder="http://hermes-studio:8648" data-testid="agent-work-action-url" />
      </label>
      <p class="aw-hint">{{ t('agentWork.actionUrlHint') }}</p>

      <h4>Pondering Orb</h4>
      <label class="aw-switch"><NSwitch v-model:value="form.shareToOrb" data-testid="agent-work-share-orb" /> {{ t('agentWork.shareToOrb') }}</label>
      <p class="aw-hint">{{ t('agentWork.shareToOrbHint') }}</p>

      <h4>{{ t('agentWork.allglanceTitle') }}</h4>
      <template v-if="!settings.allglance.fromEnv">
        <NInput v-model:value="form.allglanceUrl" size="small" :placeholder="t('agentWork.allglanceUrl')" data-testid="agent-work-allglance-url" />
        <NInput v-model:value="form.allglanceToken" size="small" type="password" :placeholder="settings.allglance.hasToken ? t('agentWork.tokenKept') : t('agentWork.allglanceToken')" />
      </template>
      <p v-else class="aw-hint">{{ t('agentWork.fromEnv') }}</p>
      <p class="aw-hint">{{ t('agentWork.allglanceHint') }}</p>

      <h4>{{ t('agentWork.wikiTitle') }}</h4>
      <NInput v-model:value="form.wikiUrl" size="small" :placeholder="`${t('agentWork.wikiUrl')} (http://llmwiki:27123)`" data-testid="agent-work-wiki-url" />
      <NInput v-model:value="form.wikiToken" size="small" type="password" :placeholder="settings.wiki.hasToken ? t('agentWork.tokenKept') : t('agentWork.wikiToken')" />
      <div class="aw-pair">
        <label class="aw-field">{{ t('agentWork.wikiFolder') }}<NInput v-model:value="form.wikiFolder" size="small" /></label>
        <label class="aw-field">{{ t('agentWork.wikiSection') }}<NInput v-model:value="form.wikiSection" size="small" /></label>
      </div>
      <p class="aw-hint">{{ t('agentWork.wikiHint') }}</p>

      <div class="aw-buttons">
        <NButton size="small" type="primary" :loading="saving" data-testid="agent-work-save" @click="save">{{ t('agentWork.save') }}</NButton>
        <NButton size="small" :loading="digesting" @click="digestNow">{{ t('agentWork.writeDigest') }}</NButton>
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.agent-work {
  display: flex;
  flex-direction: column;
  gap: calc(16px * var(--spacing-scale, 1));
  max-width: 880px;
  height: 100%;
  overflow: auto;
  padding: calc(20px * var(--spacing-scale, 1));
}

.aw-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  color: $text-primary;

  h4 {
    margin: 8px 0 0;
    font-size: 13px;
  }
}

.aw-head {
  display: flex;
  align-items: center;
  gap: 8px;

  h3 {
    margin: 0;
    font-size: 15px;
  }
}

.aw-count {
  min-width: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: $warning;
  color: #fff;
  font-size: 12px;
  text-align: center;
}

.aw-hint {
  margin: 0;
  font-size: 12px;
  color: $text-muted;
}

.aw-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-top: var(--border-width, 1px) solid $border-light;
}

.aw-row {
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  background: none;
  border-left: none;
  border-right: none;
  border-bottom: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.aw-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.aw-summary {
  flex-basis: 100%;
  margin: 2px 0 0;
  font-size: 13px;
  white-space: pre-wrap;
}

.aw-actions,
.aw-buttons {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.aw-status {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: $bg-secondary;
  color: $text-secondary;

  &[data-status='blocked'] { color: $error; }
  &[data-status='awaiting_approval'] { color: $warning; }
  &[data-status='done'] { color: $success; }
}

.aw-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aw-meta,
.aw-when,
.aw-kind {
  font-size: 12px;
  color: $text-muted;
}

.aw-activity {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 280px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
  font-size: 13px;

  li {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
}

.aw-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.aw-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.aw-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
</style>
