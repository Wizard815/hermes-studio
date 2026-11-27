<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BrowserAnnotationSubmission } from '@/utils/browser-annotation-submit'

const FilesPanel = defineAsyncComponent(() => import('./FilesPanel.vue'))
const TerminalPanel = defineAsyncComponent(() => import('./TerminalPanel.vue'))
const DesktopBrowserPanel = defineAsyncComponent(() => import('./DesktopBrowserPanel.vue'))
const BrowserPanel = defineAsyncComponent(() => import('./BrowserPanel.vue'))
withDefaults(defineProps<{
  contextReady?: boolean
  workspaceSessionId?: string | null
  workspace?: string | null
  visible: boolean
  browserVisible: boolean
  browserAvailable: boolean
  /** Server-side headless browser, used when the desktop browser bridge is absent. */
  headlessAvailable?: boolean
  sessionId?: string | null
  submit: (submission: BrowserAnnotationSubmission) => boolean | void | Promise<boolean | void>
  /** Views that take the page (Code: VS Code; Screen: the agents' screen); each opens with the chat beside it. */
  centerTabs?: Array<'code' | 'screen'>
  /** The chat's task list and folder, which used to be header buttons. */
  showTasks?: boolean
  showFolder?: boolean
  folderTitle?: string
}>(), { contextReady: true, centerTabs: () => [], showTasks: false, showFolder: false, folderTitle: '' })
const activePanel = defineModel<'files' | 'terminal' | 'browser'>('activePanel', { default: 'files' })
const emit = defineEmits<{ attach: [file: File]; center: [mode: 'code' | 'screen']; tasks: []; folder: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="chat-tools-panel">
    <div class="chat-tool-tabs" role="tablist">
      <button
        class="chat-tool-tab"
        :class="{ active: activePanel === 'files' }"
        type="button"
        role="tab"
        :title="t('drawer.files')"
        :aria-label="t('drawer.files')"
        :aria-selected="activePanel === 'files'"
        @click="activePanel = 'files'"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
        </svg>
      </button>
      <button
        class="chat-tool-tab"
        :class="{ active: activePanel === 'terminal' }"
        type="button"
        role="tab"
        :title="t('drawer.terminal')"
        :aria-label="t('drawer.terminal')"
        :aria-selected="activePanel === 'terminal'"
        @click="activePanel = 'terminal'"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3M13 15h4" />
        </svg>
      </button>
      <button
        v-if="browserAvailable || headlessAvailable"
        class="chat-tool-tab"
        :class="{ active: activePanel === 'browser' }"
        type="button"
        role="tab"
        :title="t('browser.title')"
        :aria-label="t('browser.title')"
        :aria-selected="activePanel === 'browser'"
        @click="activePanel = 'browser'"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18" />
          <circle cx="6.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
          <circle cx="9.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <template v-if="centerTabs.length || showTasks || showFolder">
        <span class="chat-tool-divider" aria-hidden="true" />
        <button
          v-if="centerTabs.includes('code')"
          class="chat-tool-tab"
          type="button"
          :title="t('vscode.centerCode')"
          :aria-label="t('vscode.centerCode')"
          data-testid="chat-tool-code"
          @click="emit('center', 'code')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" /></svg>
        </button>
        <button
          v-if="centerTabs.includes('screen')"
          class="chat-tool-tab"
          type="button"
          :title="t('screen.centerScreen')"
          :aria-label="t('screen.centerScreen')"
          data-testid="chat-tool-screen"
          @click="emit('center', 'screen')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
        </button>
        <button
          v-if="showTasks"
          class="chat-tool-tab"
          type="button"
          aria-haspopup="dialog"
          :title="t('sessionTasks.title')"
          :aria-label="t('sessionTasks.title')"
          data-testid="chat-tool-tasks"
          @click="emit('tasks')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4h6v3H9zM9 12l2 2 4-4M9 17h6" /></svg>
        </button>
        <button
          v-if="showFolder"
          class="chat-tool-tab"
          type="button"
          :title="folderTitle || t('chat.setWorkspace')"
          :aria-label="t('chat.setWorkspace')"
          data-testid="chat-tool-folder"
          @click="emit('folder')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5" /></svg>
        </button>
      </template>
    </div>
    <div class="chat-tool-content">
      <FilesPanel
        v-if="contextReady"
        v-show="activePanel === 'files'"
        :workspace-session-id="workspaceSessionId"
        :workspace="workspace"
        @attach="file => emit('attach', file)"
      />
      <TerminalPanel
        v-show="activePanel === 'terminal'"
        :visible="visible && activePanel === 'terminal'"
        :session-id="sessionId || null"
      />
      <DesktopBrowserPanel
        v-if="browserAvailable && activePanel === 'browser'"
        :submission-context="workspaceSessionId"
        :visible="browserVisible"
        :submit="submit"
      />
      <BrowserPanel
        v-else-if="headlessAvailable && activePanel === 'browser'"
        :visible="browserVisible"
        :session-id="sessionId || null"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.chat-tools-panel {
  display: flex;
  flex: 1;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.chat-tool-tabs {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  order: 2;
  width: 48px;
  height: 100%;
  gap: calc(4px * var(--spacing-scale, 1));
  padding: calc(8px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1));
  border-inline-start: var(--border-width, 1px) solid $border-color;
  background: var(--theme-sidebar-bg, $bg-sidebar-surface);
  box-sizing: border-box;
}

.chat-tool-tab {
  position: relative;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: all $transition-fast;

  svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.12);

    &::after {
      content: "";
      position: absolute;
      right: -6px;
      top: 9px;
      bottom: 9px;
      width: 2px;
      border-radius: 2px 0 0 2px;
      background: var(--accent-primary);
    }
  }
}

.chat-tool-divider {
  width: 24px;
  height: var(--border-width, 1px);
  margin: 4px 0;
  background: $border-color;
}

.chat-tool-content {
  order: 1;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--theme-content-bg, $bg-main-surface);
}

.chat-tool-content > * {
  height: 100%;
  min-height: 0;
}

</style>
