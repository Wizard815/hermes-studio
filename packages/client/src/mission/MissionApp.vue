<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NInput, NModal, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import HerdrTerminal from '@/components/coding-agents/herdr/HerdrTerminal.vue'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { useAppStore } from '@/stores/hermes/app'
import { clearApiKey } from '@/api/client'
import {
  createHerdrWorkspace,
  focusHerdrPane,
  launchHerdrAgent,
  type HerdrPaneView,
  type SpaceFolder,
} from '@/api/coding-agents/herdr'
import { useStudioFolders, type MissionFolder } from './useFolders'
import SpaceTree from './SpaceTree.vue'
import FolderEditor from './FolderEditor.vue'
import SourceChats from './sources/SourceChats.vue'
import SourceTasks from './sources/SourceTasks.vue'
import SourceProjects from './sources/SourceProjects.vue'
import SourceIdeas from './sources/SourceIdeas.vue'
import SourceUpkeep from './sources/SourceUpkeep.vue'
import ControlPanel from './sources/ControlPanel.vue'
import OrbNotConnected from './sources/OrbNotConnected.vue'
import { studioUrl, useLaunchTools, useOrbConnection } from './useMission'

type View = 'mission' | 'classic'
type Source = 'chats' | 'tasks' | 'projects' | 'ideas' | 'upkeep' | 'control'

const emit = defineEmits<{ 'signed-out': [] }>()
const { t } = useI18n()
const toast = useMessage()
const herdr = useHerdrStore()
const appStore = useAppStore()
const { tools } = useLaunchTools()

const SOURCES: Source[] = ['chats', 'tasks', 'projects', 'ideas', 'upkeep', 'control']
function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const value = localStorage.getItem(key) as T; return allowed.includes(value) ? value : fallback } catch { return fallback }
}
const view = ref<View>(stored('herdr_mission_view', ['mission', 'classic'] as const, 'mission'))
const source = ref<Source>(stored('herdr_mission_source', SOURCES, 'chats'))
/** Orb is optional: its sources wait for an Orb address and show one note without it. */
const orb = useOrbConnection()
const ORB_SOURCES = new Set<Source>(['tasks', 'projects', 'ideas', 'upkeep'])
const orbBlocked = computed(() => ORB_SOURCES.has(source.value) && (!orb.state.checked || !orb.state.configured))
const panelOpen = ref(false)
const selectedSpace = ref('')
const selectedPane = ref('')
const control = ref(false)
const editorOpen = ref(false)
const editing = ref<MissionFolder | null>(null)
/** Parent of a folder being created ('' for the top). */
const newFolderParent = ref('')
const spaceDialog = ref(false)
const spaceForm = ref({ cwd: '', label: '', folder: '' })
const agentDialog = ref(false)
const agentForm = ref({ agentId: '', provider: '', model: '', title: '', prompt: '' })
let refreshTimer = 0

watch(view, value => { try { localStorage.setItem('herdr_mission_view', value) } catch { /* ignore */ } })
watch(source, value => { try { localStorage.setItem('herdr_mission_source', value) } catch { /* ignore */ } })

const workspaces = computed(() => herdr.bridge?.workspaces ?? [])
const panes = computed(() => herdr.bridge?.panes ?? [])
const agents = computed(() => {
  const rank: Record<string, number> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 }
  return panes.value.filter(p => p.agent).sort((a, b) => (rank[a.agent_status || 'unknown'] ?? 4) - (rank[b.agent_status || 'unknown'] ?? 4))
})
const spacePanes = computed(() => panes.value.filter(p => p.workspace_id === selectedSpace.value))
const currentPane = computed(() => panes.value.find(p => p.pane_id === selectedPane.value) ?? null)
const spaceCwd = computed(() => {
  const pane = currentPane.value || spacePanes.value[0]
  return pane?.foreground_cwd || pane?.cwd || ''
})
const studioHome = studioUrl('/hermes/chat')
const studioFolders = useStudioFolders(message => toast.error(message))

function cwdOf(spaceId: string): string {
  const pane = panes.value.find(p => p.workspace_id === spaceId && p.agent) || panes.value.find(p => p.workspace_id === spaceId)
  return pane?.foreground_cwd || pane?.cwd || ''
}

function placeOf(spaceId: string): string {
  return studioFolders.folderOfSpace(spaceId, panes.value, cwdOf(spaceId), herdr.status?.home || '')
}

const providerOptions = computed(() => {
  const profile = herdr.status?.settings.profile || 'default'
  const groups = appStore.profileModelGroups.find(entry => entry.profile === profile)?.groups ?? []
  return [{ label: t('herdr.launch.agentDefault'), value: '' }, ...groups.map(g => ({ label: g.label || g.provider, value: g.provider }))]
})
const modelOptions = computed(() => {
  const profile = herdr.status?.settings.profile || 'default'
  const group = appStore.profileModelGroups.find(entry => entry.profile === profile)?.groups.find(g => g.provider === agentForm.value.provider)
  return (group?.models ?? []).map(model => ({ label: model, value: model }))
})

watch(panes, list => {
  if (!selectedSpace.value || !workspaces.value.some(w => w.workspace_id === selectedSpace.value)) {
    const focused = list.find(p => p.pane_id === herdr.bridge?.focusedPaneId)
    selectedSpace.value = focused?.workspace_id || workspaces.value[0]?.workspace_id || ''
  }
  if (!selectedPane.value || !list.some(p => p.pane_id === selectedPane.value)) {
    const inSpace = list.filter(p => p.workspace_id === selectedSpace.value)
    selectedPane.value = (inSpace.find(p => p.agent) || inSpace[0])?.pane_id || ''
  }
}, { immediate: true })

watch(selectedPane, () => { control.value = false })

function selectSpace(id: string) {
  selectedSpace.value = id
  const inSpace = panes.value.filter(p => p.workspace_id === id)
  selectedPane.value = (inSpace.find(p => p.agent) || inSpace[0])?.pane_id || ''
}

function selectPane(id: string) {
  const pane = panes.value.find(p => p.pane_id === id)
  if (pane) selectedSpace.value = pane.workspace_id
  selectedPane.value = id
  void focusHerdrPane(id).catch(() => undefined)
}

function paneName(pane: HerdrPaneView): string {
  return pane.label || pane.terminal_title_stripped || pane.agent || pane.pane_id
}

function editFolder(folder: MissionFolder) {
  editing.value = folder
  editorOpen.value = true
}

function newFolder(parentId: string) {
  editing.value = null
  newFolderParent.value = parentId
  editorOpen.value = true
}

async function saveFolder(folder: SpaceFolder) {
  if (editing.value) await studioFolders.updateFolder(folder)
  else await studioFolders.createFolder(folder, newFolderParent.value)
}

function removeFolder(folder: SpaceFolder) {
  void studioFolders.removeFolder(folder.id)
}

function newSpace(folder: MissionFolder | null) {
  spaceForm.value = { cwd: (folder?.start || '').replace(/^~(?=\/|$)/, herdr.status?.home || '~'), label: '', folder: folder?.id || '' }
  spaceDialog.value = true
}

async function createSpace() {
  try {
    const created = await createHerdrWorkspace({ cwd: spaceForm.value.cwd.trim() || undefined, label: spaceForm.value.label.trim() || undefined })
    if (created.workspaceId) {
      // New spaces made from a folder go in it, as in herdr-space-folders.
      if (spaceForm.value.folder) void studioFolders.placeSpace(created.workspaceId, spaceForm.value.folder, panes.value)
      selectedSpace.value = created.workspaceId
      selectedPane.value = created.paneId
    }
    spaceDialog.value = false
  } catch (err: any) {
    toast.error(err?.message || String(err))
  }
}

function openAgentDialog() {
  agentForm.value = { agentId: tools.value[0]?.id || '', provider: '', model: '', title: '', prompt: '' }
  agentDialog.value = true
  if (!appStore.profileModelGroups.length) void appStore.loadModels().catch(() => undefined)
}

watch(() => agentForm.value.provider, () => { agentForm.value.model = modelOptions.value[0]?.value ?? '' })

async function startAgent() {
  try {
    const { link } = await launchHerdrAgent({
      agentId: agentForm.value.agentId,
      provider: agentForm.value.provider || undefined,
      model: agentForm.value.provider ? agentForm.value.model || undefined : undefined,
      title: agentForm.value.title.trim() || undefined,
      prompt: agentForm.value.prompt.trim() || undefined,
      workspace: spaceCwd.value || undefined,
    })
    agentDialog.value = false
    selectPane(link.paneId)
  } catch (err: any) {
    toast.error(err?.message || String(err))
  }
}

function signOut() {
  clearApiKey()
  emit('signed-out')
}

onMounted(async () => {
  // ?pane=w1:p2 (from Studio's "Open in herdr") selects that pane.
  const requested = new URLSearchParams(window.location.search).get('pane')
  if (requested) selectedPane.value = requested
  herdr.acquire()
  await herdr.refresh()
  if (requested) selectPane(requested)
  await studioFolders.load()
  // Folder and chat changes made in Studio's sidebar show up here.
  refreshTimer = window.setInterval(() => { void studioFolders.refresh() }, 15000)
})
onBeforeUnmount(() => {
  herdr.release()
  if (refreshTimer) window.clearInterval(refreshTimer)
})
</script>

<template>
  <div class="mission" :data-view="view" data-testid="mission-app">
    <header class="mission-topbar" data-theme-surface="card">
      <strong class="mission-brand">herdr</strong>
      <nav class="mission-tabs" :aria-label="t('mission.paneTabs')">
        <button
          v-for="pane in spacePanes"
          :key="pane.pane_id"
          type="button"
          class="mission-tab"
          :class="{ active: pane.pane_id === selectedPane }"
          @click="selectPane(pane.pane_id)"
        >
          <AgentStatusIcon :status="pane.agent_status || 'unknown'" :live="!!pane.agent" :size="11" />
          <span>{{ paneName(pane) }}</span>
        </button>
        <button type="button" class="mission-tab mission-tab-add" :title="t('herdr.launch.button')" data-testid="mission-new-agent" @click="openAgentDialog">+</button>
      </nav>
      <span class="mission-spacer" />
      <span class="mission-conn" :data-connected="herdr.connected">{{ herdr.connected ? t('herdr.connected') : t('herdr.disconnected') }}</span>
      <button v-if="view === 'classic'" type="button" class="mission-btn" data-testid="mission-panel-toggle" @click="panelOpen = !panelOpen">{{ panelOpen ? t('mission.hideWork') : t('mission.showWork') }}</button>
      <button type="button" class="mission-btn" data-testid="mission-swap" @click="view = view === 'mission' ? 'classic' : 'mission'">{{ view === 'mission' ? t('mission.classic') : t('mission.missionControl') }}</button>
      <a v-if="studioHome" class="mission-btn" :href="studioHome" data-testid="mission-back">{{ t('herdr.backToStudio') }}</a>
      <button v-else type="button" class="mission-btn" @click="signOut">{{ t('mission.signOut') }}</button>
    </header>

    <div class="mission-body">
      <aside class="mission-rail" data-theme-surface="card">
        <SpaceTree
          class="mission-rail-tree"
          :workspaces="workspaces"
          :panes="panes"
          :folders="studioFolders.folders.value"
          :place-of="placeOf"
          :selected-space="selectedSpace"
          :selected-pane="selectedPane"
          @select-space="selectSpace"
          @select-pane="selectPane"
          @new-space="newSpace"
          @new-folder="newFolder"
          @edit-folder="editFolder"
          @toggle-folder="studioFolders.toggleFolded"
          @place-space="(spaceId, folderId) => studioFolders.placeSpace(spaceId, folderId, panes)"
          @move-folder="studioFolders.moveFolder"
        />
        <section class="mission-agents" data-testid="mission-agents">
          <header class="mission-agents-head">{{ t('mission.agents') }} <span>{{ agents.length }}</span></header>
          <button
            v-for="pane in agents"
            :key="pane.pane_id"
            type="button"
            class="mission-agent"
            :class="{ active: pane.pane_id === selectedPane }"
            @click="selectPane(pane.pane_id)"
          >
            <AgentStatusIcon :status="pane.agent_status || 'unknown'" live :size="12" />
            <span class="mission-agent-name">{{ paneName(pane) }}</span>
            <span class="mission-agent-kind">{{ pane.agent }}</span>
          </button>
          <p v-if="!agents.length" class="mission-empty">{{ t('herdr.noAgents') }}</p>
        </section>
      </aside>

      <main class="mission-main">
        <section v-if="view === 'mission' || panelOpen" class="mission-work" data-theme-surface="card">
          <nav class="mission-sources" role="tablist">
            <button
              v-for="item in SOURCES"
              :key="item"
              type="button"
              role="tab"
              class="mission-source"
              :class="{ active: source === item }"
              :aria-selected="source === item"
              :data-testid="`mission-source-${item}-tab`"
              @click="source = item"
            >{{ t(`mission.sources.${item}`) }}</button>
          </nav>
          <div class="mission-source-view">
            <SourceChats v-if="source === 'chats'" @select-pane="selectPane" />
            <template v-else-if="orbBlocked">
              <OrbNotConnected v-if="orb.state.checked" @open-control="source = 'control'" />
            </template>
            <SourceTasks v-else-if="source === 'tasks'" :panes="panes" :workspace="spaceCwd" @select-pane="selectPane" />
            <SourceProjects v-else-if="source === 'projects'" :panes="panes" :workspace="spaceCwd" @select-pane="selectPane" />
            <SourceIdeas v-else-if="source === 'ideas'" :panes="panes" :workspace="spaceCwd" @select-pane="selectPane" />
            <SourceUpkeep v-else-if="source === 'upkeep'" :panes="panes" :workspace="spaceCwd" @select-pane="selectPane" />
            <ControlPanel v-else />
          </div>
        </section>

        <section class="mission-terminals">
          <template v-if="currentPane">
            <div class="mission-pane-bar">
              <AgentStatusIcon :status="currentPane.agent_status || 'unknown'" :live="!!currentPane.agent" :size="12" />
              <strong>{{ paneName(currentPane) }}</strong>
              <span class="mission-pane-id">{{ currentPane.pane_id }}</span>
              <span class="mission-spacer" />
              <a v-if="currentPane.studioSessionId && studioUrl(`/hermes/session/${currentPane.studioSessionId}`)" class="mission-btn" :href="studioUrl(`/hermes/session/${currentPane.studioSessionId}`)!">{{ t('herdr.openChat') }}</a>
              <button type="button" class="mission-btn" data-testid="mission-take-control" @click="control = !control">{{ control ? t('herdr.releaseControl') : t('herdr.takeControl') }}</button>
            </div>
            <HerdrTerminal :key="currentPane.pane_id" :mode="control ? 'control' : 'observe'" :target="currentPane.pane_id" :takeover="control" />
          </template>
          <p v-else class="mission-empty">{{ herdr.enabled ? t('herdr.selectAgent') : t('mission.herdrOff') }}</p>
        </section>
      </main>
    </div>

    <FolderEditor v-model:show="editorOpen" :folder="editing" @save="saveFolder" @remove="removeFolder" />

    <NModal v-model:show="spaceDialog" preset="card" :title="t('mission.newSpace')" :style="{ width: 'min(420px, calc(100vw - 32px))' }">
      <form class="mission-form" @submit.prevent="createSpace">
        <label><span>{{ t('herdr.launch.workspace') }}</span><NInput v-model:value="spaceForm.cwd" placeholder="/home/me/code/project" /></label>
        <label><span>{{ t('herdr.launch.name') }}</span><NInput v-model:value="spaceForm.label" /></label>
        <NButton type="primary" attr-type="submit" block>{{ t('mission.create') }}</NButton>
      </form>
    </NModal>

    <NModal v-model:show="agentDialog" preset="card" :title="t('herdr.launch.title')" :style="{ width: 'min(480px, calc(100vw - 32px))' }">
      <form class="mission-form" @submit.prevent="startAgent">
        <label><span>{{ t('herdr.launch.agent') }}</span><NSelect v-model:value="agentForm.agentId" :options="tools.map(tool => ({ label: tool.name, value: tool.id }))" /></label>
        <label><span>{{ t('herdr.launch.provider') }}</span><NSelect v-model:value="agentForm.provider" :options="providerOptions" /></label>
        <label v-if="agentForm.provider"><span>{{ t('herdr.launch.model') }}</span><NSelect v-model:value="agentForm.model" :options="modelOptions" filterable tag /></label>
        <label><span>{{ t('herdr.launch.name') }}</span><NInput v-model:value="agentForm.title" /></label>
        <label><span>{{ t('mission.firstPrompt') }}</span><NInput v-model:value="agentForm.prompt" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" /></label>
        <p class="mission-hint">{{ t('mission.startsIn', { folder: spaceCwd || '—' }) }}</p>
        <NButton type="primary" attr-type="submit" block :disabled="!agentForm.agentId">{{ t('herdr.launch.start') }}</NButton>
      </form>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.mission {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100vh;
  padding: 8px;
  box-sizing: border-box;
  color: $text-primary;
}

.mission-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 0 10px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 10px);
}

.mission-brand {
  font-size: 14px;
}

.mission-tabs {
  display: flex;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
}

.mission-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  height: 28px;
  padding: 0 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 999px;
  background: transparent;
  color: $text-secondary;
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;

  span {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &.active {
    color: $text-primary;
    border-color: $accent-primary;
    background: rgba(var(--accent-primary-rgb), 0.12);
  }
}

.mission-tab-add {
  width: 28px;
  padding: 0;
  justify-content: center;
}

.mission-spacer {
  flex: 1 1 auto;
}

.mission-conn {
  font-size: 12px;
  color: $text-muted;

  &[data-connected="true"] {
    color: $success;
  }
}

.mission-btn {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
  background: transparent;
  color: $text-primary;
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;

  &:hover {
    border-color: $accent-primary;
  }
}

.mission-body {
  display: flex;
  flex: 1 1 auto;
  gap: 8px;
  min-height: 0;
}

.mission-rail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 0 0 268px;
  min-height: 0;
  padding: 10px 6px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 10px);
}

.mission-rail-tree {
  flex: 3 1 0;
}

.mission-agents {
  display: flex;
  flex-direction: column;
  flex: 2 1 0;
  min-height: 0;
  overflow: auto;
  border-top: var(--border-width, 1px) solid $border-light;
  padding-top: 8px;
}

.mission-agents-head {
  padding: 0 6px 4px;
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: $text-muted;
}

.mission-agent {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--radius-component, 6px);
  background: transparent;
  color: $text-primary;
  font-size: 13px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.12);
  }
}

.mission-agent-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mission-agent-kind,
.mission-pane-id {
  font-size: 11px;
  color: $text-muted;
}

.mission-main {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  gap: 8px;
  min-width: 0;
  min-height: 0;
}

.mission[data-view="classic"] .mission-main {
  flex-direction: row-reverse;
}

.mission-work {
  display: flex;
  flex-direction: column;
  flex: 3 1 0;
  min-height: 160px;
  overflow: hidden;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 10px);
}

.mission[data-view="classic"] .mission-work {
  flex: 0 0 360px;
}

.mission-sources {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 4px 6px;
  border-bottom: var(--border-width, 1px) solid $border-light;
  overflow-x: auto;
}

.mission-source {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--radius-component, 6px);
  background: transparent;
  color: $text-secondary;
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $text-primary;
    font-weight: 600;
  }
}

.mission-source-view {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.mission-terminals {
  display: flex;
  flex-direction: column;
  flex: 2 1 0;
  gap: 6px;
  min-height: 120px;
  min-width: 0;
}

.mission-pane-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.mission-empty {
  margin: 12px;
  font-size: 13px;
  color: $text-muted;
}

.mission-form {
  display: flex;
  flex-direction: column;
  gap: 10px;

  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: $text-secondary;
  }
}

.mission-hint {
  margin: 0;
  font-size: 12px;
  color: $text-muted;
}

@media (max-width: 860px) {
  .mission {
    height: auto;
    min-height: 100vh;
  }

  .mission-body,
  .mission[data-view="classic"] .mission-main {
    flex-direction: column;
  }

  .mission-rail {
    flex: 0 0 auto;
    height: 50vh;
    min-height: 300px;
  }

  .mission-work,
  .mission[data-view="classic"] .mission-work {
    flex: 0 0 auto;
    min-height: 320px;
  }

  .mission-terminals {
    min-height: 320px;
  }
}
</style>
