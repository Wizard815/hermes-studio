<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NButton, NCheckbox, NForm, NFormItem, NInput, NModal, NPopconfirm, NSelect, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  addPeerTask,
  bridgeLog,
  createPairingCode,
  groupProjects,
  listPeers,
  messagePeerProject,
  pairStudio,
  peerProjects,
  removePeer,
  setGroupProjects,
  updatePeer,
  type BridgeLogEntry,
  type SharedProject,
  type StudioPeer,
} from '@/api/studio/peers'
import type { Project } from '@/api/studio/projects'

/**
 * Connected Studios (docs/projects.md#federation): pair with another Studio
 * by a one-time code, approve it, pick the projects it may see, and see and
 * message the projects it shares back. A Studio group introduces every
 * member to every other one, and the log shows what crossed between Studios
 * (docs/projects.md#studio-groups).
 */
const props = defineProps<{ show: boolean; projects: Project[] }>()
const emit = defineEmits<{ 'update:show': [value: boolean] }>()
const { t } = useI18n()
const message = useMessage()

const self = ref<{ id: string; label: string } | null>(null)
const peers = ref<StudioPeer[]>([])
const code = ref<{ code: string; expiresAt: number } | null>(null)
const form = reactive({ url: '', code: '', selfUrl: typeof window === 'undefined' ? '' : window.location.origin, group: false, saving: false })
const shared = ref<string[]>([])
const log = ref<BridgeLogEntry[]>([])
const labelOf = (id: string) => peers.value.find(peer => peer.id === id)?.label || id
const remote = reactive<Record<string, { loading: boolean; projects: SharedProject[] | null; error: string }>>({})
const drafts = reactive<Record<string, string>>({})
const status = ref('')

const projectOptions = computed(() => props.projects.map(project => ({ label: project.name, value: project.id })))

function failed(error: any) {
  message.error(t('projects.failed', { error: error?.message || String(error) }))
}

async function refresh() {
  try {
    const result = await listPeers()
    self.value = result.self
    peers.value = result.peers
    const [projects, entries] = await Promise.all([groupProjects(), bridgeLog()])
    shared.value = projects || []
    log.value = (entries || []).slice().reverse()
  } catch (error) { failed(error) }
}

async function shareWithGroup(value: string[]) {
  try { shared.value = await setGroupProjects(value) } catch (error) { failed(error) }
}

function when(at: number): string {
  return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

watch(() => props.show, show => { if (show) void refresh() }, { immediate: true })

async function makeCode() {
  try { code.value = await createPairingCode() } catch (error) { failed(error) }
}

async function pair() {
  form.saving = true
  try {
    const peer = await pairStudio({ url: form.url.trim(), code: form.code.trim(), selfUrl: form.selfUrl.trim(), group: form.group })
    status.value = t('studios.paired', { label: peer.label })
    form.url = ''
    form.code = ''
    await refresh()
  } catch (error) { failed(error) } finally { form.saving = false }
}

async function change(peer: StudioPeer, patch: { approved?: boolean; projects?: string[]; group?: boolean }) {
  try {
    const next = await updatePeer(peer.id, patch)
    peers.value = peers.value.map(item => item.id === next.id ? next : item)
    // Letting a group member in introduces it to the others in the background.
    if (next.approved && next.group) setTimeout(() => { void refresh() }, 1500)
  } catch (error) { failed(error) }
}

async function unpair(peer: StudioPeer) {
  try {
    await removePeer(peer.id)
    delete remote[peer.id]
    await refresh()
  } catch (error) { failed(error) }
}

async function load(peer: StudioPeer) {
  remote[peer.id] = { loading: true, projects: remote[peer.id]?.projects ?? null, error: '' }
  try {
    remote[peer.id] = { loading: false, projects: await peerProjects(peer.id), error: '' }
  } catch (error: any) {
    remote[peer.id] = { loading: false, projects: null, error: error?.message || String(error) }
  }
}

const key = (peer: StudioPeer, project: SharedProject) => `${peer.id}:${project.id}`

async function send(peer: StudioPeer, project: SharedProject) {
  const text = (drafts[key(peer, project)] || '').trim()
  if (!text) return
  try {
    await messagePeerProject(peer.id, project.id, text)
    drafts[key(peer, project)] = ''
    status.value = t('studios.sent', { name: project.name })
  } catch (error) { failed(error) }
}

async function addTask(peer: StudioPeer, project: SharedProject) {
  const title = (drafts[key(peer, project)] || '').trim()
  if (!title) return
  try {
    await addPeerTask(peer.id, project.id, title)
    drafts[key(peer, project)] = ''
    status.value = t('studios.taskAdded', { name: project.name })
    await load(peer)
  } catch (error) { failed(error) }
}

function expires(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
</script>

<template>
  <NModal :show="show" preset="card" :title="t('studios.title')" style="max-width: 640px" data-testid="studios-dialog" @update:show="value => emit('update:show', value)">
    <p class="studios-intro">{{ t('studios.intro') }}</p>
    <p class="studios-status" role="status" aria-live="polite" data-testid="studios-status">{{ status }}</p>

    <section class="studios-section">
      <h3 class="studios-heading">{{ t('studios.thisStudio', { label: self?.label || '' }) }}</h3>
      <div class="studios-code">
        <NButton size="small" data-testid="studios-make-code" @click="makeCode">{{ t('studios.makeCode') }}</NButton>
        <template v-if="code">
          <code class="studios-code-value" data-testid="studios-code">{{ code.code }}</code>
          <span class="studios-hint">{{ t('studios.codeHint', { time: expires(code.expiresAt) }) }}</span>
        </template>
      </div>
    </section>

    <section class="studios-section">
      <h3 class="studios-heading">{{ t('studios.connect') }}</h3>
      <NForm label-placement="top" @submit.prevent="pair">
        <div class="studios-pair">
          <NFormItem :label="t('studios.url')" :feedback="t('studios.urlHint')">
            <NInput v-model:value="form.url" placeholder="http://studio.tailnet.ts.net:8648" data-testid="studios-url" />
          </NFormItem>
          <NFormItem :label="t('studios.code')">
            <NInput v-model:value="form.code" placeholder="ABCD-2345" data-testid="studios-code-input" />
          </NFormItem>
        </div>
        <NFormItem :label="t('studios.selfUrl')" :feedback="t('studios.selfUrlHint')">
          <NInput v-model:value="form.selfUrl" data-testid="studios-self-url" />
        </NFormItem>
        <NFormItem :show-label="false" :feedback="t('studioGroup.joinHint')">
          <NCheckbox v-model:checked="form.group" data-testid="studios-join-group">{{ t('studioGroup.join') }}</NCheckbox>
        </NFormItem>
        <NButton type="primary" attr-type="submit" :loading="form.saving" :disabled="!form.url.trim() || !form.code.trim() || !form.selfUrl.trim()" data-testid="studios-pair">
          {{ t('studios.pair') }}
        </NButton>
      </NForm>
    </section>

    <section v-if="peers.some(peer => peer.group)" class="studios-section" data-testid="studios-group">
      <h3 class="studios-heading">{{ t('studioGroup.title') }}</h3>
      <NFormItem :label="t('studioGroup.hint')">
        <NSelect multiple :value="shared" :options="projectOptions" :placeholder="t('studios.shareNone')" data-testid="studios-group-share" @update:value="shareWithGroup" />
      </NFormItem>
    </section>

    <section class="studios-section">
      <h3 class="studios-heading">{{ t('studios.pairedTitle') }}</h3>
      <p v-if="!peers.length" class="studios-hint" data-testid="studios-none">{{ t('studios.none') }}</p>
      <article v-for="peer in peers" :key="peer.id" class="studios-peer" :data-testid="`studios-peer-${peer.id}`">
        <div class="studios-peer-head">
          <div>
            <strong>{{ peer.label }}</strong>
            <span class="studios-hint"> · {{ peer.url }}</span>
            <span v-if="peer.introducedBy" class="studios-hint"> · {{ t('studioGroup.introducedBy', { label: peer.introducedBy }) }}</span>
          </div>
          <div class="studios-badges">
            <span v-if="peer.group" class="studios-state studios-state--group">{{ t('studioGroup.badge') }}</span>
            <span class="studios-state" :class="{ 'studios-state--waiting': !peer.approved }">{{ peer.approved ? t('studios.connected') : t('studios.waiting') }}</span>
          </div>
        </div>
        <div class="studios-peer-actions">
          <NButton v-if="!peer.approved" size="small" type="primary" :data-testid="`studios-approve-${peer.id}`" @click="change(peer, { approved: true })">{{ t('studios.approve') }}</NButton>
          <NButton size="small" :data-testid="`studios-load-${peer.id}`" @click="load(peer)">{{ t('studios.load') }}</NButton>
          <label class="studios-switch">
            <NSwitch size="small" :value="peer.group" :data-testid="`studios-group-${peer.id}`" @update:value="(value: boolean) => change(peer, { group: value })" />
            <span>{{ t('studioGroup.member') }}</span>
          </label>
          <NPopconfirm @positive-click="unpair(peer)">
            <template #trigger>
              <NButton size="small" quaternary :data-testid="`studios-remove-${peer.id}`">{{ t('studios.remove') }}</NButton>
            </template>
            {{ t('studios.removeConfirm', { label: peer.label }) }}
          </NPopconfirm>
        </div>
        <NFormItem :label="t('studios.share')" :feedback="peer.approved ? '' : t('studios.shareWaiting')">
          <NSelect
            multiple
            :value="peer.projects"
            :options="projectOptions"
            :placeholder="t('studios.shareNone')"
            :data-testid="`studios-share-${peer.id}`"
            @update:value="(value: string[]) => change(peer, { projects: value })"
          />
        </NFormItem>
        <div v-if="remote[peer.id]" class="studios-remote" :data-testid="`studios-remote-${peer.id}`">
          <h4 class="studios-subheading">{{ t('studios.theirs') }}</h4>
          <p v-if="remote[peer.id].loading" class="studios-hint">…</p>
          <p v-else-if="remote[peer.id].error" class="studios-hint" role="alert">{{ remote[peer.id].error }}</p>
          <p v-else-if="!remote[peer.id].projects?.length" class="studios-hint">{{ t('studios.noShared') }}</p>
          <div v-for="project in remote[peer.id].projects || []" :key="project.id" class="studios-project" :data-testid="`studios-project-${project.id}`">
            <div class="studios-project-head">
              <strong>{{ project.name }}</strong>
              <span class="studios-hint">{{ t('studios.summary', { threads: project.threads.filter(item => !item.resolved).length, needsYou: project.counts.needsYou, tasks: project.tasks.length }) }}</span>
            </div>
            <ul class="studios-list">
              <li v-for="thread in project.threads.filter(item => !item.resolved)" :key="thread.id">
                {{ thread.title }} <span class="studios-hint">· {{ thread.agent }} · {{ thread.status }}</span>
                <a v-if="thread.pr" :href="thread.pr" target="_blank" rel="noopener noreferrer" class="studios-link">PR</a>
              </li>
              <li v-for="task in project.tasks" :key="task.id">
                {{ task.title }} <span class="studios-hint">· {{ t(`projects.board.columns.${task.column}`) }}</span>
              </li>
            </ul>
            <div class="studios-send">
              <NInput
                v-model:value="drafts[key(peer, project)]"
                size="small"
                :placeholder="t('studios.message')"
                :input-props="{ 'aria-label': t('studios.message') }"
                :data-testid="`studios-message-${project.id}`"
                @keydown.enter.prevent="send(peer, project)"
              />
              <NButton size="small" type="primary" :disabled="!(drafts[key(peer, project)] || '').trim()" :data-testid="`studios-send-${project.id}`" @click="send(peer, project)">{{ t('studios.send') }}</NButton>
              <NButton size="small" :disabled="!(drafts[key(peer, project)] || '').trim()" :data-testid="`studios-add-task-${project.id}`" @click="addTask(peer, project)">{{ t('studios.addTask') }}</NButton>
            </div>
          </div>
        </div>
      </article>
    </section>

    <section class="studios-section" data-testid="studios-log">
      <h3 class="studios-heading">{{ t('studioGroup.log') }}</h3>
      <p v-if="!log.length" class="studios-hint">{{ t('studioGroup.logEmpty') }}</p>
      <ul v-else class="studios-log">
        <li v-for="entry in log" :key="`${entry.at}-${entry.peer}-${entry.direction}`">
          <span class="studios-hint">{{ when(entry.at) }} · {{ entry.direction === 'out' ? t('studioGroup.to', { label: labelOf(entry.peer) }) : t('studioGroup.from', { label: entry.label }) }} · {{ t(`studioGroup.kinds.${entry.kind}`) }} · {{ t(`studioGroup.by.${entry.by}`) }}<template v-if="entry.from"> ({{ entry.from.name }})</template></span>
          <div>{{ entry.text }}</div>
        </li>
      </ul>
    </section>
  </NModal>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.studios-intro { margin: 0 0 8px; color: $text-secondary; font-size: 13px; }
.studios-status { min-height: 18px; margin: 0 0 8px; font-size: 12px; color: $text-secondary; }
.studios-section { padding: 12px 0; border-top: var(--border-width, 1px) solid $border-light; }
.studios-heading { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: $text-primary; }
.studios-subheading { margin: 8px 0 4px; font-size: 12px; font-weight: 600; color: $text-secondary; }
.studios-hint { font-size: 12px; color: $text-secondary; }
.studios-code { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.studios-code-value {
  padding: 4px 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
  font-size: 16px;
  letter-spacing: 0.08em;
  color: $text-primary;
}
.studios-pair { display: grid; grid-template-columns: 2fr 1fr; gap: 0 12px; }
.studios-peer {
  margin-bottom: 10px;
  padding: 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 10px);
}
.studios-peer-head, .studios-project-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 6px; }
.studios-peer-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.studios-state {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  color: $text-secondary;
  border: var(--border-width, 1px) solid $border-light;

  &--waiting { color: $accent-primary; border-color: $accent-primary; }
}
.studios-project { padding: 8px 0; border-top: var(--border-width, 1px) dashed $border-light; }
.studios-list { margin: 4px 0 8px; padding-left: 18px; font-size: 13px; color: $text-primary; }
.studios-link { margin-left: 4px; color: $accent-primary; font-size: 12px; }
.studios-send { display: flex; gap: 6px; }
.studios-badges { display: flex; gap: 4px; }
.studios-state--group { color: $text-primary; }
.studios-switch { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; font-size: 12px; color: $text-secondary; }
.studios-log { margin: 0; padding: 0; list-style: none; max-height: 240px; overflow-y: auto; font-size: 13px; color: $text-primary; }
.studios-log li { padding: 4px 0; border-bottom: var(--border-width, 1px) dashed $border-light; overflow-wrap: anywhere; }

@media (max-width: 560px) {
  .studios-pair { grid-template-columns: 1fr; }
  .studios-send { flex-wrap: wrap; }
}
</style>
