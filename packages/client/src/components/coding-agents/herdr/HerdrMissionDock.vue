<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HerdrPaneView } from '@/api/coding-agents/herdr'
import SourceChats from '@/mission/sources/SourceChats.vue'
import SourceTasks from '@/mission/sources/SourceTasks.vue'
import SourceProjects from '@/mission/sources/SourceProjects.vue'
import SourceIdeas from '@/mission/sources/SourceIdeas.vue'
import SourceUpkeep from '@/mission/sources/SourceUpkeep.vue'
import ControlPanel from '@/mission/sources/ControlPanel.vue'
import OrbNotConnected from '@/mission/sources/OrbNotConnected.vue'
import { useOrbConnection } from '@/mission/useMission'
import { DOCK_TABS, ORB_TABS, type DockTab } from './herdr-layout'

/**
 * Mission's tools beside herdr: Chats (every chat, asleep ones marked "z"),
 * Pondering Orb's Tasks, Projects, Ideas and Upkeep, and Control.
 */
const props = defineProps<{ tab: DockTab; panes: HerdrPaneView[]; workspace: string; drawer: boolean }>()
const emit = defineEmits<{ 'update:tab': [tab: DockTab]; 'select-pane': [paneId: string]; close: [] }>()
const { t } = useI18n()
const orb = useOrbConnection()
const orbBlocked = computed(() => ORB_TABS.has(props.tab) && (!orb.state.checked || !orb.state.configured))
</script>

<template>
  <aside class="herdr-dock" :class="{ 'is-drawer': drawer }" data-theme-surface="card" data-testid="herdr-dock" :aria-label="t('herdr.dock.title')">
    <header class="herdr-dock-head">
      <nav class="herdr-dock-tabs" role="tablist" :aria-label="t('herdr.dock.title')">
        <button
          v-for="item in DOCK_TABS"
          :key="item"
          type="button"
          role="tab"
          class="herdr-dock-tab"
          :class="{ active: tab === item }"
          :aria-selected="tab === item"
          :data-testid="`herdr-dock-tab-${item}`"
          @click="emit('update:tab', item)"
        >{{ t(`mission.sources.${item}`) }}</button>
      </nav>
      <button type="button" class="herdr-dock-close" :aria-label="t('herdr.dock.hide')" :title="t('herdr.dock.hide')" data-testid="herdr-dock-close" @click="emit('close')">×</button>
    </header>
    <div class="herdr-dock-body">
      <SourceChats v-if="tab === 'chats'" @select-pane="pane => emit('select-pane', pane)" />
      <template v-else-if="orbBlocked">
        <OrbNotConnected v-if="orb.state.checked" @open-control="emit('update:tab', 'control')" />
      </template>
      <SourceTasks v-else-if="tab === 'tasks'" :panes="panes" :workspace="workspace" @select-pane="pane => emit('select-pane', pane)" />
      <SourceProjects v-else-if="tab === 'projects'" :panes="panes" :workspace="workspace" @select-pane="pane => emit('select-pane', pane)" />
      <SourceIdeas v-else-if="tab === 'ideas'" :panes="panes" :workspace="workspace" @select-pane="pane => emit('select-pane', pane)" />
      <SourceUpkeep v-else-if="tab === 'upkeep'" :panes="panes" :workspace="workspace" @select-pane="pane => emit('select-pane', pane)" />
      <ControlPanel v-else />
    </div>
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
  flex-wrap: wrap;
  gap: 2px;
  min-width: 0;
}

.herdr-dock-tab {
  flex: none;
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
}
</style>
