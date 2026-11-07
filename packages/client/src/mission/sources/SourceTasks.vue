<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { callOrbTool, type OrbTask } from '@/api/studio/orb'
import type { HerdrPaneView } from '@/api/coding-agents/herdr'
import LaunchButtons from '../LaunchButtons.vue'

/**
 * Pondering Orb tasks (its plans are CalDAV to-dos), grouped by list. Each
 * card starts an agent with the task as its first prompt.
 */
const props = defineProps<{ panes: HerdrPaneView[]; workspace: string }>()
const emit = defineEmits<{ 'select-pane': [paneId: string] }>()
const { t } = useI18n()
const toast = useMessage()
const tasks = ref<OrbTask[]>([])
const error = ref('')
const loading = ref(false)
const showDone = ref(false)
const newTitle = ref('')
const newList = ref('')

const groups = computed(() => {
  const byList = new Map<string, OrbTask[]>()
  for (const task of tasks.value) {
    if (task.done && !showDone.value) continue
    const list = task.list || t('mission.inbox')
    byList.set(list, [...(byList.get(list) || []), task])
  }
  return [...byList.entries()].map(([list, items]) => ({ list, items })).sort((a, b) => a.list.localeCompare(b.list))
})

const PRIORITY_CLASS: Record<string, string> = { urgent: 'is-bad', do_now: 'is-bad', high: 'is-warn' }

async function load() {
  loading.value = true
  try {
    tasks.value = await callOrbTool<OrbTask[]>('orb_list_tasks', { openOnly: false })
    error.value = ''
  } catch (err: any) {
    error.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

function promptFor(task: OrbTask): string {
  return [
    `Task from my Pondering Orb plans (list: ${task.list || 'inbox'}): ${task.title}`,
    task.due ? `Due: ${task.due}.` : '',
    'When it is done, mark it complete with the ekko_studio_use_orb_update tool (action complete_task).',
  ].filter(Boolean).join('\n')
}

async function complete(task: OrbTask) {
  try {
    await callOrbTool('orb_complete_task', { title: task.title, list: task.list })
    await load()
  } catch (err: any) {
    toast.error(err?.message || String(err))
  }
}

async function add() {
  const title = newTitle.value.trim()
  if (!title) return
  try {
    await callOrbTool('orb_add_task', { title, ...(newList.value.trim() ? { list: newList.value.trim() } : {}) })
    newTitle.value = ''
    await load()
  } catch (err: any) {
    toast.error(err?.message || String(err))
  }
}

onMounted(load)
</script>

<template>
  <section class="source" data-testid="mission-source-tasks">
    <form class="source-bar" @submit.prevent="add">
      <NInput v-model:value="newTitle" size="small" class="task-input" :placeholder="t('mission.newTask')" />
      <NInput v-model:value="newList" size="small" class="task-list-input" :placeholder="t('mission.taskList')" />
      <NButton size="small" attr-type="submit" :disabled="!newTitle.trim()">{{ t('mission.add') }}</NButton>
      <span class="source-spacer" />
      <label class="task-toggle"><input v-model="showDone" type="checkbox" /> {{ t('mission.showDone') }}</label>
      <button type="button" class="source-link" @click="load">{{ t('mission.refresh') }}</button>
    </form>
    <p v-if="error" class="source-error">{{ error }}</p>
    <p v-else-if="!loading && !groups.length" class="source-empty">{{ t('mission.noTasks') }}</p>
    <div class="source-groups">
      <div v-for="group in groups" :key="group.list" class="source-group">
        <h4>{{ group.list }} <span>{{ group.items.length }}</span></h4>
        <article v-for="task in group.items" :key="`${group.list}:${task.title}`" class="source-card" data-theme-surface="card" data-testid="mission-task">
          <span class="source-card-title" :class="{ 'is-done': task.done }">{{ task.title }}</span>
          <div class="source-card-meta">
            <span v-if="task.due" class="source-chip">{{ task.due }}</span>
            <span v-if="task.priority && task.priority !== 'none'" class="source-chip" :class="PRIORITY_CLASS[task.priority]">{{ task.priority }}</span>
          </div>
          <div v-if="!task.done" class="source-card-actions">
            <LaunchButtons
              :card-key="`task:${task.list}:${task.title}`"
              :title="task.title"
              :prompt="promptFor(task)"
              :workspace="props.workspace || undefined"
              :panes="props.panes"
              @launched="pane => emit('select-pane', pane)"
            />
            <span class="source-spacer" />
            <button type="button" class="source-link" @click="complete(task)">{{ t('mission.complete') }}</button>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './source';

.task-input {
  flex: 1 1 220px;
  max-width: 360px;
}

.task-list-input {
  width: 140px;
}

.task-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.is-done {
  color: $text-muted;
  text-decoration: line-through;
}
</style>
