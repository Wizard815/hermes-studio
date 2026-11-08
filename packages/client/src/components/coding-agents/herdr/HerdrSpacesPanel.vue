<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { createHerdrWorkspace, focusHerdrPane, type HerdrPaneView, type HerdrWorkspace, type SpaceFolder } from '@/api/coding-agents/herdr'
import { useHerdrStore } from '@/stores/hermes/herdr'
import SpaceTree from '@/mission/SpaceTree.vue'
import FolderEditor from '@/mission/FolderEditor.vue'
import { useStudioFolders, type MissionFolder } from '@/mission/useFolders'

/**
 * The chat page's sidebar in herdr mode: Mission's Spaces tree (Studio's chat
 * folders 1:1, each herdr space with its agents and chats) in place of the
 * chat list. Picking an agent shows it in the herdr center and opens its
 * Studio chat, so swapping back to Chat lands on the same conversation.
 */
const props = defineProps<{ activeSessionId: string | null }>()
const emit = defineEmits<{ 'open-chat': [sessionId: string] }>()

const toast = useMessage()
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

function cwdOf(spaceId: string): string {
  const pane = panes.value.find(p => p.workspace_id === spaceId && p.agent) || panes.value.find(p => p.workspace_id === spaceId)
  return pane?.foreground_cwd || pane?.cwd || ''
}

function placeOf(spaceId: string): string {
  return folders.folderOfSpace(spaceId, panes.value, cwdOf(spaceId), herdr.status?.home || '')
}

async function selectPane(paneId: string) {
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
})
</script>

<template>
  <div class="herdr-spaces-panel" data-testid="herdr-spaces-panel">
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
    <FolderEditor v-model:show="editorOpen" :folder="editing" @save="saveFolder" @remove="folder => folders.removeFolder(folder.id)" />
  </div>
</template>

<style scoped lang="scss">
.herdr-spaces-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 6px 4px;
}

.herdr-spaces-tree {
  flex: 1 1 auto;
}
</style>
