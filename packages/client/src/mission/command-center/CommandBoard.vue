<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import { callOrbTool, type OrbTask } from '@/api/studio/orb'
import { studioUrl, useOrbConnection } from '../useMission'
import { useCommandCenter } from './useCommandCenter'
import { BOARD_COLUMNS, buildBoard, formatAge, type BoardCard, type BoardColumn } from './model'

/**
 * Board (Command Center's board and tasks): all work as columns, from Agent
 * work, Pondering Orb's open tasks and live agents. A card follows its agent:
 * a work item an agent is doing shows that agent's state.
 */
const emit = defineEmits<{ 'select-pane': [paneId: string] }>()
const { t } = useI18n()
const toast = useMessage()
const cc = useCommandCenter()
const orb = useOrbConnection()
const orbTasks = ref<OrbTask[]>([])
const orbError = ref('')
const folded = ref<Set<BoardColumn>>(new Set())

const board = computed(() => buildBoard({ work: cc.state.work, orbTasks: orbTasks.value, agents: cc.agents.value, since: cc.state.since }))
const total = computed(() => BOARD_COLUMNS.reduce((sum, column) => sum + board.value[column].length, 0))

async function loadOrb() {
  if (!orb.state.configured) { orbTasks.value = []; return }
  try {
    orbTasks.value = await callOrbTool<OrbTask[]>('orb_list_tasks', { openOnly: true })
    orbError.value = ''
  } catch (err: any) { orbError.value = err?.message || String(err) }
}
watch(() => orb.state.configured, () => { void loadOrb() })

function toggle(column: BoardColumn) {
  const next = new Set(folded.value)
  if (next.has(column)) next.delete(column)
  else next.add(column)
  folded.value = next
}

function studioChat(card: BoardCard) {
  return card.sessionId ? studioUrl(`/hermes/session/${card.sessionId}?center=chat`) : null
}

async function decide(card: BoardCard, decision: 'approve' | 'reject') {
  if (!card.workId) return
  try { await cc.decide(card.workId, decision) } catch (err: any) { toast.error(err?.message || String(err)) }
}

async function refresh() {
  await Promise.all([cc.refresh(), loadOrb()])
}

onMounted(() => { void loadOrb() })
</script>

<template>
  <section class="source cc-board" data-testid="cc-board">
    <div class="source-bar">
      <span>{{ t('commandCenter.board.count', { n: total }) }}</span>
      <span class="source-spacer" />
      <NButton size="tiny" quaternary :loading="cc.state.loading" @click="refresh">{{ t('mission.refresh') }}</NButton>
    </div>
    <p v-if="!orb.state.configured && orb.state.checked" class="cc-note">{{ t('commandCenter.board.noOrb') }}</p>
    <p v-if="orbError" class="source-error">{{ orbError }}</p>
    <div class="cc-lanes">
      <section v-for="column in BOARD_COLUMNS" :key="column" class="cc-lane" :class="`is-${column}`" :data-testid="`cc-board-${column}`">
        <h4>
          <button type="button" class="cc-lane-head" :aria-expanded="!folded.has(column)" @click="toggle(column)">
            <span aria-hidden="true">{{ folded.has(column) ? '▸' : '▾' }}</span>
            {{ t(`commandCenter.board.column.${column}`) }}
            <span class="cc-lane-count">{{ board[column].length }}</span>
          </button>
        </h4>
        <template v-if="!folded.has(column)">
          <p v-if="!board[column].length" class="cc-lane-empty">—</p>
          <article v-for="card in board[column]" :key="card.key" class="source-card cc-card" data-theme-surface="card">
            <div class="source-card-meta">
              <AgentStatusIcon v-if="card.live" :status="card.live" live :size="11" />
              <span class="source-chip">{{ t(`commandCenter.board.source.${card.source}`) }}</span>
              <span v-if="card.agent" class="source-chip">{{ card.agent }}</span>
              <span class="source-spacer" />
              <span v-if="card.at && card.source !== 'orb'">{{ formatAge(card.at, cc.state.now) }}</span>
            </div>
            <div class="source-card-title">{{ card.title }}</div>
            <div v-if="card.detail" class="cc-detail">{{ card.detail }}</div>
            <div v-if="card.paneId || studioChat(card) || column === 'approval'" class="source-card-actions">
              <template v-if="column === 'approval' && card.workId">
                <NButton size="tiny" type="primary" @click="decide(card, 'approve')">{{ t('agentWork.approve') }}</NButton>
                <NButton size="tiny" @click="decide(card, 'reject')">{{ t('agentWork.reject') }}</NButton>
              </template>
              <NButton v-if="card.paneId" size="tiny" @click="emit('select-pane', card.paneId)">{{ t('mission.showPane') }}</NButton>
              <a v-if="studioChat(card)" class="source-link" :href="studioChat(card)!">{{ t('mission.openInStudio') }}</a>
            </div>
          </article>
        </template>
      </section>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '../sources/source';

.cc-lanes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cc-lane h4 {
  margin: 0 0 4px;
}

.cc-lane-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 4px;
  border: 0;
  border-bottom: 2px solid $border-light;
  background: transparent;
  color: $text-secondary;
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 1px;
  }
}

.is-working .cc-lane-head { border-bottom-color: $accent-primary; }
.is-blocked .cc-lane-head { border-bottom-color: $warning; }
.is-approval .cc-lane-head { border-bottom-color: $info; }
.is-done .cc-lane-head { border-bottom-color: $success; }

.cc-lane-count {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.cc-lane-empty {
  margin: 2px 6px 6px;
  color: $text-muted;
  font-size: 12px;
}

.cc-detail {
  font-size: 12px;
  color: $text-muted;
  word-break: break-word;
}

.cc-note {
  margin: 0;
  font-size: 11.5px;
  color: $text-muted;
}
</style>
