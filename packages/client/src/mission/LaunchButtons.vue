<script setup lang="ts">
import { ref } from 'vue'
import { NTooltip, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import type { HerdrPaneView } from '@/api/coding-agents/herdr'
import { launchForCard, useLaunchTools } from './useMission'

/** One button per installed agent: start it on this card, or go to the one already on it. */
const props = defineProps<{
  cardKey: string
  title: string
  prompt: string
  workspace?: string
  panes: HerdrPaneView[]
}>()
const emit = defineEmits<{ launched: [paneId: string] }>()
const { t } = useI18n()
const toast = useMessage()
const { tools } = useLaunchTools()
const busy = ref('')

function logo(agentId: string) {
  return chatSessionAgentAvatar({ source: 'coding_agent', agent: agentId === 'claude-code' ? 'claude' : agentId, codingAgentId: agentId } as any)
}

async function start(agentId: string) {
  busy.value = agentId
  const name = tools.value.find(tool => tool.id === agentId)?.name || agentId
  const pending = toast.loading(t('mission.agentStarting', { agent: name }), { duration: 0 })
  try {
    const result = await launchForCard({ key: props.cardKey, agentId, title: props.title, prompt: props.prompt, workspace: props.workspace, panes: props.panes })
    emit('launched', result.paneId)
    if (!result.reused) toast.success(t('mission.agentStarted'))
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    pending.destroy()
    busy.value = ''
  }
}
</script>

<template>
  <span class="launch-buttons">
    <NTooltip v-for="tool in tools.slice(0, 3)" :key="tool.id" trigger="hover">
      <template #trigger>
        <button
          type="button"
          class="launch-button"
          :disabled="!!busy"
          :aria-label="t('mission.startWith', { agent: tool.name })"
          data-testid="mission-launch"
          @click.stop="start(tool.id)"
        >
          <img :src="logo(tool.id).src" alt="" />
        </button>
      </template>
      {{ t('mission.startWith', { agent: tool.name }) }}
    </NTooltip>
  </span>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.launch-buttons {
  display: inline-flex;
  gap: 4px;
}

.launch-button {
  display: inline-grid;
  place-items: center;
  width: 25px;
  height: 25px;
  padding: 0;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
  background: transparent;
  cursor: pointer;

  img {
    width: 15px;
    height: 15px;
    border-radius: 3px;
  }

  &:hover:not(:disabled) {
    border-color: $accent-primary;
  }

  &:disabled {
    cursor: progress;
  }
}
</style>
