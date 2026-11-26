<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HerdrPaneView } from '@/api/coding-agents/herdr'
import SourceChats from '@/mission/sources/SourceChats.vue'
import SourceTasks from '@/mission/sources/SourceTasks.vue'
import SourceProjects from '@/mission/sources/SourceProjects.vue'
import SourceIdeas from '@/mission/sources/SourceIdeas.vue'
import SourceUpkeep from '@/mission/sources/SourceUpkeep.vue'
import ControlPanel from '@/mission/sources/ControlPanel.vue'
import OrbNotConnected from '@/mission/sources/OrbNotConnected.vue'
import CommandInbox from '@/mission/command-center/CommandInbox.vue'
import CommandAgents from '@/mission/command-center/CommandAgents.vue'
import CommandFiles from '@/mission/command-center/CommandFiles.vue'
import CommandBoard from '@/mission/command-center/CommandBoard.vue'
import CommandSkills from '@/mission/command-center/CommandSkills.vue'
import CommandUsage from '@/mission/command-center/CommandUsage.vue'
import { useCommandCenter } from '@/mission/command-center/useCommandCenter'
import { useOrbConnection } from '@/mission/useMission'
import { COMMAND_TABS, MISSION_TABS, ORB_TABS, dockTabLabelKey, isCommandTab, nextDockTab, type DockTab } from './herdr-layout'

/**
 * The Tools dock beside herdr. First row, Command Center (ideas from Herdr App
 * add-ons): Inbox, Agents, Files, Board and Skills, with a usage strip at the
 * foot. Second row, Mission's tools: Chats (every chat, asleep ones marked
 * "z"), Pondering Orb's Tasks, Projects, Ideas and Upkeep, and Control.
 */
const props = defineProps<{ tab: DockTab; panes: HerdrPaneView[]; workspace: string; drawer: boolean }>()
const emit = defineEmits<{ 'update:tab': [tab: DockTab]; 'select-pane': [paneId: string]; close: [] }>()
const { t } = useI18n()
const orb = useOrbConnection()
const orbBlocked = computed(() => ORB_TABS.has(props.tab) && (!orb.state.checked || !orb.state.configured))
const cc = useCommandCenter()
const rows = [COMMAND_TABS, MISSION_TABS] as const
const tabList = ref<HTMLElement | null>(null)

/** Arrow keys, Home and End move between tabs (one list over both rows). */
function onTabKey(event: KeyboardEvent) {
  const next = nextDockTab(props.tab, event.key)
  if (!next) return
  event.preventDefault()
  emit('update:tab', next)
  void nextTick(() => tabList.value?.querySelector<HTMLElement>(`[data-testid="herdr-dock-tab-${next}"]`)?.focus())
}
const selectPane = (pane: string) => emit('select-pane', pane)
</script>

<template>
  <aside class="herdr-dock" :class="{ 'is-drawer': drawer }" data-theme-surface="card" data-testid="herdr-dock" :aria-label="t('herdr.dock.title')">
    <header class="herdr-dock-head">
      <nav ref="tabList" class="herdr-dock-tabs" role="tablist" :aria-label="t('herdr.dock.title')" @keydown="onTabKey">
        <div v-for="(row, index) in rows" :key="index" class="herdr-dock-row" role="none">
          <button
            v-for="item in row"
            :key="item"
            type="button"
            role="tab"
            class="herdr-dock-tab"
            :class="{ active: tab === item }"
            :aria-selected="tab === item"
            :tabindex="tab === item ? 0 : -1"
            :data-testid="`herdr-dock-tab-${item}`"
            @click="emit('update:tab', item)"
          >{{ t(dockTabLabelKey(item)) }}<span
            v-if="item === 'inbox' && cc.unseen.value"
            class="herdr-dock-badge"
            data-testid="herdr-dock-inbox-badge"
            :aria-label="t('commandCenter.inbox.new', { n: cc.unseen.value })"
          >{{ cc.unseen.value > 99 ? '99+' : cc.unseen.value }}</span></button>
        </div>
      </nav>
      <button type="button" class="herdr-dock-close" :aria-label="t('herdr.dock.hide')" :title="t('herdr.dock.hide')" data-testid="herdr-dock-close" @click="emit('close')">×</button>
    </header>
    <div class="herdr-dock-body" :class="{ 'is-command': isCommandTab(tab) }">
      <CommandInbox v-if="tab === 'inbox'" @select-pane="selectPane" />
      <CommandAgents v-else-if="tab === 'agents'" @select-pane="selectPane" />
      <CommandFiles v-else-if="tab === 'files'" :phone="drawer" />
      <CommandBoard v-else-if="tab === 'board'" @select-pane="selectPane" />
      <CommandSkills v-else-if="tab === 'skills'" />
      <SourceChats v-else-if="tab === 'chats'" @select-pane="selectPane" />
      <template v-else-if="orbBlocked">
        <OrbNotConnected v-if="orb.state.checked" @open-control="emit('update:tab', 'control')" />
      </template>
      <SourceTasks v-else-if="tab === 'tasks'" :panes="panes" :workspace="workspace" @select-pane="selectPane" />
      <SourceProjects v-else-if="tab === 'projects'" :panes="panes" :workspace="workspace" @select-pane="selectPane" />
      <SourceIdeas v-else-if="tab === 'ideas'" :panes="panes" :workspace="workspace" @select-pane="selectPane" />
      <SourceUpkeep v-else-if="tab === 'upkeep'" :panes="panes" :workspace="workspace" @select-pane="selectPane" />
      <ControlPanel v-else />
    </div>
    <CommandUsage />
  </aside>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.herdr-dock {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  overflow: hidden;
}

.herdr-dock-head {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 6px 6px 8px;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.herdr-dock-tabs {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.herdr-dock-row {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.herdr-dock-row + .herdr-dock-row {
  padding-top: 3px;
  border-top: var(--border-width, 1px) dashed $border-light;
}

.herdr-dock-tab {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    color: $text-primary;
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.14);
    color: $text-primary;
  }

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 1px;
  }
}

.herdr-dock-badge {
  display: inline-block;
  min-width: 16px;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 999px;
  background: $warning;
  color: $bg-card;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

.herdr-dock-close {
  flex: none;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: $text-secondary;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.1);
  }
}

.herdr-dock-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;

  &.is-command {
    padding: 0;
  }
}
</style>
