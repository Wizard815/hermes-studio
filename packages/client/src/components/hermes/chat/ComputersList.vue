<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchHerdrMachineAgents, type HerdrMachine, type HerdrRemoteAgent } from '@/api/coding-agents/herdr'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'

/**
 * Other computers (herdr's saved SSH machines, docs/harness/herdr.md) in the
 * chat list: each computer folds open to its folders, and each folder to the
 * agents running there, nested like the chat folders. Picking one opens that
 * computer's herdr in Terminal, on that agent.
 */
const props = defineProps<{ machines: HerdrMachine[]; activeMachine?: string }>()
const emit = defineEmits<{
  back: []
  open: [machineId: string, paneId?: string]
}>()
const { t } = useI18n()

const agents = ref<Record<string, { agents: HerdrRemoteAgent[]; error: string; loaded: boolean }>>({})
const folded = ref(new Set<string>())

async function load() {
  const next: typeof agents.value = { ...agents.value }
  await Promise.all(props.machines.map(async machine => {
    try { next[machine.id] = { agents: (await fetchHerdrMachineAgents(machine.id)).agents || [], error: '', loaded: true } } catch (error: any) { next[machine.id] = { agents: [], error: error?.message || String(error), loaded: true } }
  }))
  agents.value = next
}

/** A computer's agents, by folder (the last part of where each runs). */
const folders = computed(() => Object.fromEntries(props.machines.map(machine => {
  const groups = new Map<string, HerdrRemoteAgent[]>()
  for (const agent of agents.value[machine.id]?.agents || []) {
    const name = (agent.cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || agent.workspace_id || '~'
    groups.set(name, [...(groups.get(name) || []), agent])
  }
  return [machine.id, [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => ({ key: `${machine.id}/${name}`, name, agents: list }))]
})))

function toggle(key: string) {
  const next = new Set(folded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  folded.value = next
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void load()
  timer = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 15_000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
defineExpose({ refresh: load })
</script>

<template>
  <div class="computers-list" data-testid="computers-list">
    <div class="computers-head">
      <button type="button" class="computers-back" data-testid="computers-back" @click="emit('back')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
        <span>{{ t('projects.back') }}</span>
      </button>
    </div>
    <div role="tree" :aria-label="t('studioTerminal.otherComputers')">
      <template v-for="machine in machines" :key="machine.id">
        <div
          class="computers-row computers-machine"
          :class="{ active: activeMachine === machine.id }"
          role="treeitem"
          tabindex="0"
          :aria-expanded="!folded.has(machine.id)"
          :data-testid="`computers-machine-${machine.id}`"
          @click="toggle(machine.id)"
          @keydown.enter="toggle(machine.id)"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="computers-chevron" :class="{ collapsed: folded.has(machine.id) }" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
          <svg class="computers-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
          <span class="computers-label">{{ machine.label || machine.target }}</span>
          <small v-if="agents[machine.id]?.error" class="computers-note">{{ t('studioTerminal.unreachable') }}</small>
          <span v-else class="computers-count">{{ agents[machine.id]?.agents.length ?? '' }}</span>
          <button type="button" class="computers-open" :data-testid="`computers-open-${machine.id}`" @click.stop="emit('open', machine.id)">{{ t('herdr.centerHerdr') }}</button>
        </div>
        <template v-if="!folded.has(machine.id)">
          <p v-if="agents[machine.id]?.loaded && !agents[machine.id]?.error && !agents[machine.id]?.agents.length" class="computers-empty">{{ t('studioTerminal.noRemoteAgents') }}</p>
          <template v-for="folder in folders[machine.id]" :key="folder.key">
            <div class="computers-row computers-folder" role="treeitem" tabindex="0" :aria-expanded="!folded.has(folder.key)" style="--tree-depth: 1" @click="toggle(folder.key)" @keydown.enter="toggle(folder.key)">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="computers-chevron" :class="{ collapsed: folded.has(folder.key) }" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
              <svg class="computers-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" /></svg>
              <span class="computers-label">{{ folder.name }}</span>
              <span class="computers-count">{{ folder.agents.length }}</span>
            </div>
            <template v-if="!folded.has(folder.key)">
              <button
                v-for="agent in folder.agents"
                :key="agent.pane_id"
                type="button"
                class="computers-row computers-agent"
                role="treeitem"
                style="--tree-depth: 2"
                :data-testid="`computers-agent-${machine.id}-${agent.pane_id}`"
                @click="emit('open', machine.id, agent.pane_id)"
              >
                <AgentStatusIcon :status="(agent.agent_status as any) || 'unknown'" live :size="11" />
                <span class="computers-name">{{ agent.label || agent.agent }}</span>
                <span class="computers-agent-kind">{{ agent.agent }}</span>
              </button>
            </template>
          </template>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.computers-list { display: flex; flex-direction: column; gap: 1px; }

.computers-head { display: flex; align-items: center; padding: 2px 8px 6px; }

.computers-back,
.computers-open {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font: inherit;
  font-size: 12px;
  color: $text-secondary;
  background: none;
  border: 0;
  border-radius: var(--radius-component, 6px);
  cursor: pointer;

  &:hover { color: $text-primary; }
}

.computers-back { min-height: 32px; padding: 4px 6px; }

.computers-row {
  --tree-step: calc(11px * var(--spacing-scale, 1));
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 32px;
  padding: 4px 10px;
  padding-inline-start: calc(10px * var(--spacing-scale, 1) + var(--tree-depth, 0) * var(--tree-step));
  border: 0;
  border-radius: var(--radius-component, 6px);
  background: none;
  color: $text-secondary;
  font: inherit;
  font-size: 13px;
  text-align: start;
  cursor: pointer;
  user-select: none;

  &:hover,
  &.active { background: rgba(var(--accent-primary-rgb), 0.06); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}

.computers-machine { font-weight: 600; color: $text-primary; }

.computers-chevron {
  flex-shrink: 0;
  transform: rotate(90deg);
  transition: transform 0.15s ease;

  &.collapsed { transform: rotate(0deg); }
}

.computers-icon { flex-shrink: 0; color: $text-muted; }

.computers-label,
.computers-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.computers-label { flex: 1; }
.computers-name { flex: 1; color: $text-primary; }

.computers-count,
.computers-note,
.computers-agent-kind { flex-shrink: 0; font-size: 11px; color: $text-muted; }

.computers-open {
  min-height: 24px;
  padding: 2px 6px;
  border: var(--border-width, 1px) solid $border-light;
}

.computers-empty {
  margin: 0;
  padding: 4px 10px 6px calc(10px + 2 * 11px);
  font-size: 12px;
  color: $text-muted;
}
</style>
