<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { callOrbTool, type OrbProject } from '@/api/studio/orb'
import type { HerdrPaneView } from '@/api/coding-agents/herdr'
import LaunchButtons from '../LaunchButtons.vue'

/** Pondering Orb's project board: one column per status, a card per project. */
const props = defineProps<{ panes: HerdrPaneView[]; workspace: string }>()
const emit = defineEmits<{ 'select-pane': [paneId: string] }>()
const { t } = useI18n()
const toast = useMessage()
const STATUSES = ['next', 'active', 'blocked', 'paused', 'shipped'] as const
const projects = ref<OrbProject[]>([])
const error = ref('')
const loading = ref(false)

const columns = computed(() => STATUSES.map(status => ({
  status,
  items: projects.value.filter(project => !project.archived && (project.status || 'next') === status),
})))

async function load() {
  loading.value = true
  try {
    projects.value = await callOrbTool<OrbProject[]>('orb_list_projects')
    error.value = ''
  } catch (err: any) {
    error.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

async function move(project: OrbProject, status: string) {
  try {
    await callOrbTool('orb_move_project', { name: project.name, status })
    await load()
  } catch (err: any) {
    toast.error(err?.message || String(err))
  }
}

function promptFor(project: OrbProject): string {
  return [
    `Work on my project "${project.name}" from Pondering Orb.`,
    project.next ? `Next step: ${project.next}` : '',
    'Read its open tasks with the ekko_studio_use_orb_read tool (kind tasks, list set to the project name), and log progress with ekko_studio_use_orb_update (action add_log).',
  ].filter(Boolean).join('\n')
}

onMounted(load)
</script>

<template>
  <section class="source" data-testid="mission-source-projects">
    <div class="source-bar">
      <span>{{ t('mission.projectsHint') }}</span>
      <span class="source-spacer" />
      <button type="button" class="source-link" @click="load">{{ t('mission.refresh') }}</button>
    </div>
    <p v-if="error" class="source-error">{{ error }}</p>
    <div class="source-groups">
      <div v-for="column in columns" :key="column.status" class="source-group">
        <h4>{{ t(`mission.status.${column.status}`) }} <span>{{ column.items.length }}</span></h4>
        <article v-for="project in column.items" :key="project.name" class="source-card" data-theme-surface="card" data-testid="mission-project">
          <span class="source-card-title">{{ project.name }}</span>
          <span v-if="project.next" class="source-card-meta">{{ project.next }}</span>
          <div class="source-card-meta">
            <span class="source-chip">{{ t('mission.openTasks', { n: project.openTasks ?? 0 }) }}</span>
          </div>
          <div class="source-card-actions">
            <LaunchButtons
              :card-key="`project:${project.name}`"
              :title="project.name"
              :prompt="promptFor(project)"
              :workspace="props.workspace || undefined"
              :panes="props.panes"
              @launched="pane => emit('select-pane', pane)"
            />
            <span class="source-spacer" />
            <select class="project-move" data-theme-surface="input" :value="project.status" :aria-label="t('mission.moveProject')" @change="move(project, ($event.target as HTMLSelectElement).value)">
              <option v-for="status in STATUSES" :key="status" :value="status">{{ t(`mission.status.${status}`) }}</option>
            </select>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './source';

.project-move {
  padding: 2px 4px;
  font-size: 11.5px;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
}
</style>
