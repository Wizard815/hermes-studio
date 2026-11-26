<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HerdrPaneView } from '@/api/coding-agents/herdr'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import { agentSections, shortDuration, type AgentSort } from './herdr-app-layout'

/**
 * The Agents section of the Herdr App layout's sidebar (Herdr App's `agents`
 * mod, as Herdr Roundup's roundup-agents draws it): every pane running an
 * agent, in Working / Blocked / Done / Idle sections with a count, each row
 * the agent's icon, its name, how long it has been in its state and its
 * status ring. The clock button sorts by status or groups by space.
 */
const props = defineProps<{
  panes: HerdrPaneView[]
  focusedPane: string
  spaceName: (workspaceId: string) => string
  chatTitle: (sessionId: string) => string
  /** Chats' waiting panes: not agents. */
  waiting?: ReadonlySet<string>
}>()
const emit = defineEmits<{ 'focus-pane': [paneId: string] }>()
const { t } = useI18n()

const SORT_KEY = 'studio_herdr_agents_sort'
function readSort(): AgentSort {
  try { return localStorage.getItem(SORT_KEY) === 'space' ? 'space' : 'priority' } catch { return 'priority' }
}
const sort = ref<AgentSort>(readSort())
const sortMenu = ref(false)
function setSort(value: AgentSort) {
  sort.value = value
  sortMenu.value = false
  try { localStorage.setItem(SORT_KEY, value) } catch { /* private mode */ }
}

const sections = computed(() => agentSections(props.panes, { sort: sort.value, spaceName: props.spaceName, chatTitle: props.chatTitle, waiting: props.waiting }))
const folded = ref(new Set<string>())
function toggle(id: string) {
  const next = new Set(folded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  folded.value = next
}

// Times in state tick once a minute (Herdr App's agents list does the same).
const now = ref(Date.now())
let timer = 0
onMounted(() => { timer = window.setInterval(() => { now.value = Date.now() }, 20_000) })
onBeforeUnmount(() => window.clearInterval(timer))

const avatar = (agent: string, studioAgent: string | null) => chatSessionAgentAvatar({ agent: studioAgent || agent, codingAgentId: studioAgent || undefined, source: 'coding_agent' })
</script>

<template>
  <section class="ag" data-testid="herdr-app-agents" :aria-label="t('herdrApp.agents')">
    <header class="ag-head">
      <span class="ag-title">{{ t('herdrApp.agents') }}</span>
      <span class="ag-spacer" />
      <div class="ag-sort">
        <button type="button" class="ag-icon" :title="t('herdrApp.sortAgents')" :aria-label="t('herdrApp.sortAgents')" :aria-expanded="sortMenu" data-testid="herdr-app-agents-sort" @click="sortMenu = !sortMenu">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </button>
        <div v-if="sortMenu" class="ag-menu" role="menu" data-theme-surface="card">
          <button v-for="option in (['priority', 'space'] as const)" :key="option" type="button" role="menuitemradio" :aria-checked="sort === option" class="ag-menu-item" :data-testid="`herdr-app-agents-sort-${option}`" @click="setSort(option)">
            <span>{{ option === 'priority' ? t('herdrApp.sortPriority') : t('herdrApp.sortSpace') }}</span>
            <span v-if="sort === option" aria-hidden="true">✓</span>
          </button>
        </div>
      </div>
    </header>
    <div class="ag-list">
      <p v-if="!sections.length" class="ag-empty">{{ t('herdrApp.noAgents') }}</p>
      <template v-for="section in sections" :key="section.id">
        <button type="button" class="ag-group" :class="section.status ? `is-${section.status}` : ''" :aria-expanded="!folded.has(section.id)" :data-testid="`herdr-app-agents-group-${section.id}`" @click="toggle(section.id)">
          <span class="ag-group-label">{{ section.status ? t(`herdrApp.groups.${section.status}`) : section.label }}</span>
          <span class="ag-group-count">{{ section.rows.length }}</span>
        </button>
        <template v-if="!folded.has(section.id)">
          <button
            v-for="row in section.rows"
            :key="row.paneId"
            type="button"
            class="ag-row"
            :class="{ active: row.paneId === focusedPane, 'is-idle': row.status === 'idle' || row.status === 'unknown' }"
            :data-testid="`herdr-app-agent-${row.paneId}`"
            :title="`${row.name} · ${row.agent}`"
            @click="emit('focus-pane', row.paneId)"
          >
            <img class="ag-avatar" :src="avatar(row.agent, row.studioAgent).src" :alt="avatar(row.agent, row.studioAgent).label" loading="lazy" />
            <span class="ag-name">{{ row.name }}</span>
            <span v-if="row.status === 'blocked'" class="ag-needs">{{ t('herdrApp.needsYou') }}</span>
            <span v-else-if="row.since" class="ag-when">{{ shortDuration(now - row.since) }}</span>
            <span class="ag-ring" :class="`is-${row.status}`" role="img" :aria-label="t(`agentStatus.${row.status}`)" />
          </button>
        </template>
      </template>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.ag {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-height: 90px;
  border-top: var(--border-width, 1px) solid $border-light;
  font-size: 13.5px;
}

.ag-head {
  display: flex;
  flex: none;
  align-items: center;
  height: 40px;
  padding: 6px 14px 0 16px;
}

.ag-title {
  font-size: 11.5px;
  font-weight: 500;
  color: $text-muted;
}

.ag-spacer {
  flex: 1 1 auto;
}

.ag-sort {
  position: relative;
}

.ag-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-muted;
  cursor: pointer;

  &:hover {
    color: $text-primary;
  }
}

.ag-menu {
  position: absolute;
  z-index: 5;
  top: 28px;
  right: 0;
  min-width: 150px;
  padding: 4px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 8px;
  background: var(--theme-card-bg, $bg-card);
  box-shadow: 0 8px 24px color-mix(in srgb, $text-primary 14%, transparent);
}

.ag-menu-item {
  display: flex;
  justify-content: space-between;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: $text-primary;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.ag-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.ag-empty {
  margin: 4px 8px;
  font-size: 12px;
  line-height: 1.45;
  color: $text-muted;
}

.ag-group {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 26px;
  margin-top: 6px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: $text-muted;
  font-size: 11.5px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;

  &.is-working .ag-group-label { color: $warning; }
  &.is-blocked .ag-group-label { color: $error; }
  &.is-done .ag-group-label { color: $success; }
}

.ag-group-count {
  color: $text-muted;
}

.ag-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-primary;
  font-size: inherit;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.07);
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.12);
  }

  &.is-idle .ag-name {
    color: $text-secondary;
  }
}

.ag-avatar {
  flex: none;
  width: 17px;
  height: 17px;
  border-radius: 4px;
  object-fit: contain;
}

.ag-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ag-when {
  flex: none;
  font-size: 11.5px;
  color: $text-muted;
}

.ag-needs {
  flex: none;
  padding: 0 6px;
  border-radius: 5px;
  background: color-mix(in srgb, $error 15%, transparent);
  color: $error;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 18px;
}

// The status ring (Herdr App's agents mod): a spinning ring while working,
// a dot when done, a hollow ring when idle.
.ag-ring {
  flex: none;
  box-sizing: border-box;
  width: 11px;
  height: 11px;
  margin: 0 1px;
  border-radius: 999px;
  border: 1.5px solid $text-muted;

  &.is-working {
    border-color: $warning;
    border-right-color: transparent;
    animation: ag-spin 0.9s linear infinite;
  }

  &.is-blocked {
    border-color: $error;
    background: $error;
  }

  &.is-done {
    width: 8px;
    height: 8px;
    margin: 0 2.5px;
    border: 0;
    background: $success;
  }

  &.is-idle,
  &.is-unknown {
    width: 8px;
    height: 8px;
    margin: 0 2.5px;
  }
}

@keyframes ag-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .ag-ring.is-working { animation: none; }
}
</style>
