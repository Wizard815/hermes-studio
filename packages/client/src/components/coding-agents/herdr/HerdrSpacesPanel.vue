<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { createHerdrWorkspace, fetchHerdrMachineAgents, focusHerdrPane, type HerdrMachine, type HerdrPaneView, type HerdrRemoteAgent, type HerdrWorkspace, type SpaceFolder } from '@/api/coding-agents/herdr'
import { useHerdrStore } from '@/stores/hermes/herdr'
import SpaceTree from '@/mission/SpaceTree.vue'
import FolderEditor from '@/mission/FolderEditor.vue'
import { useStudioFolders, type MissionFolder } from '@/mission/useFolders'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'

/**
 * The chat page's sidebar in herdr mode: Mission's Spaces tree (Studio's chat
 * folders 1:1, each herdr space with its agents and chats) in place of the
 * chat list. Picking an agent shows it in the herdr center and opens its
 * Studio chat, so swapping back to Chat lands on the same conversation.
 */
const props = withDefaults(defineProps<{ activeSessionId: string | null; newChatKey?: string; machines?: HerdrMachine[]; machine?: string }>(), { newChatKey: '', machines: () => [], machine: '' })
const emit = defineEmits<{ 'open-chat': [sessionId: string]; 'new-chat': []; 'open-machine': [id: string, paneId?: string]; 'select-local': [] }>()

const toast = useMessage()
const { t } = useI18n()
const herdr = useHerdrStore()
const folders = useStudioFolders(message => toast.error(message))
const editorOpen = ref(false)
const editing = ref<MissionFolder | null>(null)
const newFolderParent = ref('')
const pickedSpace = ref('')
let refreshTimer = 0

const workspaces = computed<HerdrWorkspace[]>(() => herdr.bridge?.workspaces || [])
const panes = computed<HerdrPaneView[]>(() => herdr.bridge?.panes || [])
const chatPane = computed(() => panes.value.find(pane => pane.studioSessionId && pane.studioSessionId === props.activeSessionId) ?? null)
const selectedPane = computed(() => chatPane.value?.pane_id || herdr.bridge?.focusedPaneId || '')
const selectedSpace = computed(() => pickedSpace.value || panes.value.find(pane => pane.pane_id === selectedPane.value)?.workspace_id || '')

/** Agents most in need of you first, as in Mission and herdr. */
const agents = computed(() => {
  const rank: Record<string, number> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 }
  return panes.value.filter(p => p.agent).sort((a, b) => (rank[a.agent_status || 'unknown'] ?? 4) - (rank[b.agent_status || 'unknown'] ?? 4))
})

function paneName(pane: HerdrPaneView): string {
  return pane.label || pane.terminal_title_stripped || pane.agent || pane.pane_id
}

function cwdOf(spaceId: string): string {
  const pane = panes.value.find(p => p.workspace_id === spaceId && p.agent) || panes.value.find(p => p.workspace_id === spaceId)
  return pane?.foreground_cwd || pane?.cwd || ''
}

function placeOf(spaceId: string): string {
  return folders.folderOfSpace(spaceId, panes.value, cwdOf(spaceId), herdr.status?.home || '')
}

/** herdr remote: each saved machine's agents, over herdr's API on SSH. */
const remoteAgents = ref<Record<string, HerdrRemoteAgent[]>>({})
const remoteErrors = ref<Record<string, string>>({})
let machinesTimer = 0

async function loadRemoteAgents() {
  await Promise.all(props.machines.map(async machine => {
    try {
      remoteAgents.value = { ...remoteAgents.value, [machine.id]: (await fetchHerdrMachineAgents(machine.id)).agents }
      remoteErrors.value = { ...remoteErrors.value, [machine.id]: '' }
    } catch (err: any) {
      remoteErrors.value = { ...remoteErrors.value, [machine.id]: err?.message || String(err) }
    }
  }))
}

watch(() => props.machines.map(machine => machine.id).join(','), ids => {
  if (machinesTimer) window.clearInterval(machinesTimer)
  machinesTimer = 0
  if (!ids) return
  void loadRemoteAgents()
  machinesTimer = window.setInterval(() => { void loadRemoteAgents() }, 15000)
}, { immediate: true })

async function selectPane(paneId: string) {
  if (props.machine) emit('select-local')
  pickedSpace.value = ''
  await focusHerdrPane(paneId).catch(() => undefined)
  const chat = panes.value.find(pane => pane.pane_id === paneId)?.studioSessionId
  if (chat && chat !== props.activeSessionId) emit('open-chat', chat)
}

function selectSpace(spaceId: string) {
  pickedSpace.value = spaceId
  const pane = panes.value.find(p => p.workspace_id === spaceId && p.studioSessionId) || panes.value.find(p => p.workspace_id === spaceId && p.agent) || panes.value.find(p => p.workspace_id === spaceId)
  if (pane) void selectPane(pane.pane_id).then(() => { pickedSpace.value = spaceId })
}

/** A new space opens in the folder's start directory and is filed there. */
async function newSpace(folder: MissionFolder | null) {
  try {
    const created = await createHerdrWorkspace({ cwd: folder?.start?.replace(/^~(?=\/|$)/, herdr.status?.home || '~') || undefined, label: folder?.name })
    if (folder && created.workspaceId) await folders.placeSpace(created.workspaceId, folder.id, panes.value)
    await herdr.refresh()
  } catch (err: any) {
    toast.error(err?.message || String(err))
  }
}

function newFolder(parentId: string) {
  editing.value = null
  newFolderParent.value = parentId
  editorOpen.value = true
}

function editFolder(folder: MissionFolder) {
  editing.value = folder
  editorOpen.value = true
}

async function saveFolder(folder: SpaceFolder) {
  if (editing.value) await folders.updateFolder(folder)
  else await folders.createFolder(folder, newFolderParent.value)
}

onMounted(async () => {
  herdr.acquire()
  if (!herdr.status) void herdr.refresh()
  await folders.load()
  // Folder and chat changes made elsewhere in Studio show up here.
  refreshTimer = window.setInterval(() => { void folders.refresh() }, 15000)
})
onBeforeUnmount(() => {
  herdr.release()
  if (refreshTimer) window.clearInterval(refreshTimer)
  if (machinesTimer) window.clearInterval(machinesTimer)
})
</script>

<template>
  <div class="herdr-spaces-panel" data-testid="herdr-spaces-panel">
    <!-- The chat list's New chat, which herdr mode hides with the list. -->
    <button type="button" class="herdr-spaces-new-chat" data-testid="herdr-spaces-new-chat" :title="newChatKey ? newChatKey.replace(/^prefix\+/i, 'prefix then ') : undefined" @click="emit('new-chat')">
      <span aria-hidden="true">+</span> {{ t('chat.newChat') }}
    </button>
    <SpaceTree
      class="herdr-spaces-tree"
      :workspaces="workspaces"
      :panes="panes"
      :folders="folders.folders.value"
      :place-of="placeOf"
      :selected-space="selectedSpace"
      :selected-pane="selectedPane"
      @select-space="selectSpace"
      @select-pane="selectPane"
      @new-space="newSpace"
      @new-folder="newFolder"
      @edit-folder="editFolder"
      @toggle-folder="folders.toggleFolded"
      @place-space="(spaceId, folderId) => folders.placeSpace(spaceId, folderId, panes)"
      @move-folder="folders.moveFolder"
    />
    <section class="herdr-spaces-agents" data-testid="herdr-spaces-agents">
      <header class="herdr-spaces-agents-head">{{ t('mission.agents') }} <span>{{ agents.length }}</span></header>
      <button
        v-for="pane in agents"
        :key="pane.pane_id"
        type="button"
        class="herdr-spaces-agent"
        :class="{ active: pane.pane_id === selectedPane }"
        @click="selectPane(pane.pane_id)"
      >
        <AgentStatusIcon :status="pane.agent_status || 'unknown'" live :size="12" />
        <span class="herdr-spaces-agent-name">{{ paneName(pane) }}</span>
        <span class="herdr-spaces-agent-kind">{{ pane.agent }}</span>
      </button>
      <p v-if="!agents.length" class="herdr-spaces-empty">{{ t('herdr.noAgents') }}</p>
      <!-- herdr remote: saved machines and their agents; picking one opens that machine's herdr. -->
      <template v-for="machine in machines" :key="machine.id">
        <button
          type="button"
          class="herdr-spaces-machine"
          :class="{ active: props.machine === machine.id }"
          :data-testid="`herdr-spaces-machine-${machine.id}`"
          @click="emit('open-machine', machine.id)"
        >
          <span class="herdr-spaces-agent-name">{{ machine.label || machine.target }}</span>
          <span class="herdr-spaces-agent-kind">{{ remoteErrors[machine.id] ? t('herdr.machineUnreachable') : (remoteAgents[machine.id]?.length ?? '…') }}</span>
        </button>
        <button
          v-for="agent in remoteAgents[machine.id] || []"
          :key="`${machine.id}:${agent.pane_id}`"
          type="button"
          class="herdr-spaces-agent herdr-spaces-agent--remote"
          data-testid="herdr-spaces-remote-agent"
          @click="emit('open-machine', machine.id, agent.pane_id)"
        >
          <AgentStatusIcon :status="(agent.agent_status as any) || 'unknown'" live :size="12" />
          <span class="herdr-spaces-agent-name">{{ agent.label }}</span>
          <span class="herdr-spaces-agent-kind">{{ agent.agent }}</span>
        </button>
      </template>
    </section>
    <FolderEditor v-model:show="editorOpen" :folder="editing" @save="saveFolder" @remove="folder => folders.removeFolder(folder.id)" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.herdr-spaces-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 6px 4px;
}

.herdr-spaces-new-chat {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  margin: 0 4px 6px;
  padding: 0 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
  background: transparent;
  color: $text-primary;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    border-color: $accent-primary;
    background: rgba(var(--accent-primary-rgb), 0.06);
  }
}

.herdr-spaces-tree {
  flex: 3 1 0;
}

.herdr-spaces-agents {
  display: flex;
  flex: 2 1 0;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
  margin-top: 8px;
  padding-top: 8px;
  border-top: var(--border-width, 1px) solid $border-light;
}

.herdr-spaces-agents-head {
  padding: 0 6px 4px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: $text-muted;

  span {
    margin-left: 4px;
  }
}

.herdr-spaces-agent {
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

.herdr-spaces-machine {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 26px;
  margin-top: 6px;
  padding: 0 8px;
  border: 0;
  border-top: var(--border-width, 1px) solid $border-light;
  background: transparent;
  color: $text-secondary;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  text-align: left;
  cursor: pointer;

  &.active,
  &:hover {
    color: $text-primary;
  }
}

.herdr-spaces-agent--remote {
  padding-left: 16px;
}

.herdr-spaces-agent-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.herdr-spaces-agent-kind,
.herdr-spaces-empty {
  font-size: 11px;
  color: $text-muted;
}

.herdr-spaces-empty {
  margin: 4px 8px;
}
</style>
