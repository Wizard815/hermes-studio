<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import { fetchCommandCenterSettings, saveCommandCenterSettings } from '@/api/studio/command-center'
import { studioUrl } from '../useMission'
import { useCommandCenter } from './useCommandCenter'
import { formatAge, type InboxItem, type InboxKind } from './model'

/**
 * Inbox (Command Center's idea): what needs you now. Blocked agents, Agent
 * work awaiting approval (decide here), failed jobs, failed CI and review
 * requests (when the server's `gh` is signed in), and agents done since you
 * last looked. Seen marks are this viewer's own.
 */
const emit = defineEmits<{ 'select-pane': [paneId: string] }>()
const { t } = useI18n()
const toast = useMessage()
const cc = useCommandCenter()
const showSeen = ref(false)
const deciding = ref('')

const fresh = computed(() => cc.inbox.value.filter(item => !item.seen))
const seenItems = computed(() => cc.inbox.value.filter(item => item.seen))
const shown = computed(() => (showSeen.value ? cc.inbox.value : fresh.value))

const GLYPH: Record<InboxKind, 'blocked' | 'done' | 'working' | 'unknown'> = { approval: 'blocked', blocked: 'blocked', job: 'unknown', ci: 'unknown', review: 'unknown', done: 'done' }

function studioChat(item: InboxItem) {
  return item.sessionId ? studioUrl(`/hermes/session/${item.sessionId}?center=chat`) : null
}

function open(item: InboxItem) {
  if (item.paneId) emit('select-pane', item.paneId)
  else if (item.url) window.open(item.url, '_blank', 'noopener')
  else if (item.jobId) window.location.hash = '#/hermes/jobs'
  else if (item.workId) window.location.hash = '#/hermes/connections?tab=agent-work'
  else if (studioChat(item)) window.location.hash = `#/hermes/session/${item.sessionId}?center=chat`
}

function onKey(event: KeyboardEvent, item: InboxItem) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    open(item)
  }
}

async function decide(item: InboxItem, decision: 'approve' | 'reject') {
  if (!item.workId) return
  deciding.value = item.key
  try {
    await cc.decide(item.workId, decision)
    toast.success(decision === 'approve' ? t('commandCenter.inbox.approved') : t('commandCenter.inbox.rejected'))
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    deciding.value = ''
  }
}

/** GitHub: what the Inbox asks the server's `gh` for. */
const github = computed(() => cc.state.github)
const githubLine = computed(() => {
  const value = github.value
  if (!value) return cc.state.errors.github ? t('commandCenter.inbox.githubError', { error: cc.state.errors.github }) : ''
  if (!value.available) return t('commandCenter.inbox.githubMissing')
  if (!value.signedIn) return t('commandCenter.inbox.githubSignedOut')
  if (!value.enabled) return t('commandCenter.inbox.githubOff')
  if (value.error) return t('commandCenter.inbox.githubError', { error: value.error })
  return t('commandCenter.inbox.githubOn', { login: value.login || '', repos: value.repos.length ? value.repos.join(', ') : t('commandCenter.inbox.allRepos') })
})
const settingsOpen = ref(false)
const ghEnabled = ref(true)
const ghRepos = ref('')
const savingSettings = ref(false)
async function toggleSettings() {
  settingsOpen.value = !settingsOpen.value
  if (!settingsOpen.value) return
  try {
    const settings = await fetchCommandCenterSettings()
    ghEnabled.value = settings.github.enabled
    ghRepos.value = settings.github.repos.join(', ')
  } catch (err: any) { toast.error(err?.message || String(err)) }
}
async function saveSettings() {
  savingSettings.value = true
  try {
    const settings = await saveCommandCenterSettings({ github: { enabled: ghEnabled.value, repos: ghRepos.value } })
    ghRepos.value = settings.github.repos.join(', ')
    await cc.reloadGithub()
    settingsOpen.value = false
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    savingSettings.value = false
  }
}
</script>

<template>
  <section class="source cc-inbox" data-testid="cc-inbox">
    <div class="source-bar">
      <strong class="cc-count" data-testid="cc-inbox-count">{{ t('commandCenter.inbox.new', { n: fresh.length }) }}</strong>
      <span class="source-spacer" />
      <NButton size="tiny" quaternary :disabled="!fresh.length" data-testid="cc-inbox-seen-all" @click="cc.markSeen(fresh)">{{ t('commandCenter.inbox.markAllSeen') }}</NButton>
      <NButton size="tiny" quaternary :loading="cc.state.loading" @click="cc.refresh({ github: true })">{{ t('mission.refresh') }}</NButton>
    </div>
    <p v-if="!shown.length" class="source-empty" data-testid="cc-inbox-empty">{{ t('commandCenter.inbox.empty') }}</p>
    <ul class="cc-list" role="list">
      <li
        v-for="item in shown"
        :key="item.key"
        class="source-card cc-item"
        :class="[`is-${item.kind}`, { 'is-seen': item.seen }]"
        data-theme-surface="card"
        :data-testid="`cc-inbox-item-${item.kind}`"
      >
        <div class="source-card-meta">
          <AgentStatusIcon :status="GLYPH[item.kind]" live :size="12" />
          <span class="cc-kind">{{ t(`commandCenter.inbox.kind.${item.kind}`) }}</span>
          <span v-if="item.at" class="cc-age">{{ formatAge(item.at, cc.state.now) }}</span>
        </div>
        <div class="cc-title" role="link" tabindex="0" @click="open(item)" @keydown="onKey($event, item)">{{ item.title }}</div>
        <div v-if="item.detail" class="cc-detail">{{ item.detail }}</div>
        <div class="source-card-actions">
          <template v-if="item.kind === 'approval'">
            <NButton size="tiny" type="primary" :loading="deciding === item.key" data-testid="cc-inbox-approve" @click="decide(item, 'approve')">{{ t('agentWork.approve') }}</NButton>
            <NButton size="tiny" :disabled="deciding === item.key" data-testid="cc-inbox-reject" @click="decide(item, 'reject')">{{ t('agentWork.reject') }}</NButton>
          </template>
          <NButton v-if="item.paneId" size="tiny" @click="emit('select-pane', item.paneId)">{{ t('mission.showPane') }}</NButton>
          <a v-if="studioChat(item)" class="source-link" :href="studioChat(item)!">{{ t('mission.openInStudio') }}</a>
          <a v-if="item.url" class="source-link" :href="item.url" target="_blank" rel="noopener">{{ t('commandCenter.inbox.openGithub') }}</a>
          <a v-if="item.jobId" class="source-link" href="#/hermes/jobs">{{ t('commandCenter.inbox.openJobs') }}</a>
          <span class="source-spacer" />
          <button v-if="!item.seen" type="button" class="cc-seen" :title="t('commandCenter.inbox.markSeen')" :aria-label="t('commandCenter.inbox.markSeen')" @click="cc.markSeen([item])">✓</button>
        </div>
      </li>
    </ul>
    <button v-if="seenItems.length" type="button" class="source-link cc-toggle" data-testid="cc-inbox-show-seen" @click="showSeen = !showSeen">
      {{ showSeen ? t('commandCenter.inbox.hideSeen') : t('commandCenter.inbox.showSeen', { n: seenItems.length }) }}
    </button>
    <footer class="cc-github">
      <span data-testid="cc-inbox-github">{{ githubLine }}</span>
      <button v-if="github?.available" type="button" class="source-link" :aria-expanded="settingsOpen" @click="toggleSettings">{{ t('commandCenter.inbox.githubSettings') }}</button>
      <div v-if="settingsOpen" class="cc-github-settings">
        <label class="cc-row"><NSwitch v-model:value="ghEnabled" size="small" /> {{ t('commandCenter.inbox.githubEnabled') }}</label>
        <NInput v-model:value="ghRepos" size="small" :placeholder="t('commandCenter.inbox.githubRepos')" />
        <NButton size="tiny" type="primary" :loading="savingSettings" @click="saveSettings">{{ t('commandCenter.save') }}</NButton>
      </div>
    </footer>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '../sources/source';

.cc-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cc-count {
  color: $text-primary;
}

.cc-item {
  border-left-width: 3px;

  &.is-approval,
  &.is-blocked {
    border-left-color: $warning;
  }

  &.is-job,
  &.is-ci {
    border-left-color: $error;
  }

  &.is-review {
    border-left-color: $info;
  }

  &.is-done {
    border-left-color: $success;
  }

  &.is-seen .cc-title {
    color: $text-secondary;
  }
}

.cc-kind {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  font-size: 10.5px;
}

.cc-age {
  margin-left: auto;
}

.cc-title {
  font-weight: 500;
  word-break: break-word;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: $accent-primary;
    outline: none;
    text-decoration: underline;
  }
}

.cc-detail {
  font-size: 12px;
  color: $text-muted;
  word-break: break-word;
}

.cc-seen {
  width: 22px;
  height: 22px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 999px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: $success;
    border-color: $success;
  }
}

.cc-toggle {
  align-self: flex-start;
}

.cc-github {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: auto;
  padding-top: 6px;
  border-top: var(--border-width, 1px) solid $border-light;
  font-size: 11.5px;
  color: $text-muted;
}

.cc-github-settings {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.cc-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: $text-secondary;
}
</style>
