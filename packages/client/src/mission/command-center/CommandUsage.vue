<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchUsageStats, type UsageStatsResponse } from '@/api/studio/sessions'
import { useCommandCenter } from './useCommandCenter'
import { formatTokens } from './model'
import PlanBars from './PlanBars.vue'

/**
 * Usage strip (Command Center's usage bars) at the foot of the Tools dock:
 * today's tokens per agent from Studio's usage records, today's cost, and
 * Codex's plan windows where Codex reported them. Folds to one line.
 */
const { t } = useI18n()
const cc = useCommandCenter()
const KEY = 'studio_herdr_usage_open'
// Open by default on wide screens; folded on a phone, where the drawer is short.
const open = ref((() => {
  const wide = typeof window === 'undefined' || window.innerWidth > 640
  try {
    const saved = localStorage.getItem(KEY)
    return saved === null ? wide : saved !== '0'
  } catch { return wide }
})())
const today = ref<UsageStatsResponse | null>(null)
let timer = 0

const NAMES: Record<string, string> = { 'claude-code': 'Claude Code', claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', ekko: 'Ekko' }

const rows = computed(() => {
  const list = (today.value?.agent_usage || []).map(row => ({
    agent: row.agent,
    name: NAMES[row.agent] || row.agent,
    tokens: row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens,
  })).filter(row => row.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 5)
  const max = Math.max(1, ...list.map(row => row.tokens))
  return list.map(row => ({ ...row, percent: Math.round((row.tokens / max) * 100) }))
})
const total = computed(() => rows.value.reduce((sum, row) => sum + row.tokens, 0))
const cost = computed(() => today.value?.total_cost || 0)
const codex = computed(() => cc.state.limits.find(limit => limit.agent === 'codex') || null)
const codexPeak = computed(() => Math.round(Math.max(codex.value?.primary?.usedPercent || 0, codex.value?.secondary?.usedPercent || 0)))

async function load() {
  try { today.value = await fetchUsageStats(1) } catch { today.value = null }
}
function toggle() {
  open.value = !open.value
  try { localStorage.setItem(KEY, open.value ? '1' : '0') } catch { /* private mode */ }
}

onMounted(() => {
  void load()
  timer = window.setInterval(() => { void load() }, 120_000)
})
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <footer class="cc-usage" data-testid="cc-usage">
    <button type="button" class="cc-usage-head" :aria-expanded="open" @click="toggle">
      <span aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <span>{{ t('commandCenter.usage.title') }}</span>
      <span class="cc-usage-sum">{{ t('commandCenter.usage.today', { tokens: formatTokens(total) }) }}<template v-if="cost"> · ${{ cost.toFixed(2) }}</template><template v-if="codex"> · Codex {{ codexPeak }}%</template></span>
    </button>
    <div v-if="open" class="cc-usage-body">
      <div v-for="row in rows" :key="row.agent" class="cc-meter">
        <div class="cc-meter-label"><span>{{ row.name }}</span><span>{{ formatTokens(row.tokens) }}</span></div>
        <div class="cc-bar" role="meter" :aria-valuenow="row.percent" aria-valuemin="0" aria-valuemax="100" :aria-label="row.name"><span :style="{ width: `${row.percent}%` }" /></div>
      </div>
      <p v-if="!rows.length" class="cc-usage-empty">{{ t('commandCenter.usage.none') }}</p>
      <PlanBars v-if="codex" :limits="codex" compact />
      <p v-else class="cc-usage-empty">{{ t('commandCenter.usage.noLimits') }}</p>
    </div>
  </footer>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './command-center';

.cc-usage {
  flex: none;
  border-top: var(--border-width, 1px) solid $border-light;
  padding: 4px 10px 6px;
  font-size: 11.5px;
  color: $text-secondary;
}

.cc-usage-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: $text-secondary;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 1px;
  }
}

.cc-usage-sum {
  margin-left: auto;
  font-weight: 400;
  color: $text-muted;
  font-variant-numeric: tabular-nums;
}

.cc-usage-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
  padding-top: 4px;
}

.cc-usage-empty {
  margin: 0;
  font-size: 11px;
  color: $text-muted;
}
</style>
