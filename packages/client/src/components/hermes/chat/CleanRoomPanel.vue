<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton } from 'naive-ui'
import {
  getCleanRoomCheck, getCleanRoomEgress, rerunCleanRoomCheck,
  type CleanRoomEgress, type CleanRoomLeakReport, type CleanRoomSelfCheck,
} from '@/api/coding-agents'

/**
 * A clean-room chat's room report, short and collapsible above the messages:
 * the self-check from inside the container, secret-looking files found in the
 * chat's folder before it was mounted, and the room's outside connections.
 */
const props = defineProps<{ sessionId: string; canRerun?: boolean }>()
const { t } = useI18n()

const selfCheck = ref<CleanRoomSelfCheck | null>(null)
const leaks = ref<CleanRoomLeakReport | null>(null)
const egress = ref<CleanRoomEgress | null>(null)
const loaded = ref(false)
const expanded = ref(false)
const rerunning = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  const id = props.sessionId
  if (!id || (typeof document !== 'undefined' && document.hidden && loaded.value)) return
  try {
    const [check, log] = await Promise.all([getCleanRoomCheck(id), getCleanRoomEgress(id, 200)])
    if (id !== props.sessionId) return
    selfCheck.value = check.selfCheck
    leaks.value = check.leaks
    egress.value = log
    loaded.value = true
  } catch {
    // Not allowed to see it (or not a clean room any more): show nothing.
    if (id === props.sessionId) loaded.value = false
  }
}

async function rerun() {
  rerunning.value = true
  try { selfCheck.value = (await rerunCleanRoomCheck(props.sessionId)).selfCheck } catch { /* the next load shows the state */ }
  rerunning.value = false
  void load()
}

watch(() => props.sessionId, () => {
  selfCheck.value = null; leaks.value = null; egress.value = null; loaded.value = false; expanded.value = false
  void load()
})
onMounted(() => {
  void load()
  timer = setInterval(() => { void load() }, 5000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

const leakCount = computed(() => leaks.value?.findings.length || 0)
const blockedCount = computed(() => egress.value?.entries.filter(entry => !entry.allowed).length || 0)
const checkState = computed(() => selfCheck.value?.state || 'pending')
const checkSummary = computed(() => {
  if (!selfCheck.value) return t('chat.cleanRoomPanel.checkPending')
  if (selfCheck.value.error) return t('chat.cleanRoomPanel.check_fail')
  return t(`chat.cleanRoomPanel.check_${selfCheck.value.state}`)
})
const tone = computed(() => checkState.value === 'fail' ? 'fail' : (checkState.value === 'warn' || leakCount.value) ? 'warn' : checkState.value === 'pass' ? 'pass' : 'info')
/** Checks that say something: every failure and warning, then the passes, then the plain facts. */
const checks = computed(() => {
  const order = { fail: 0, warn: 1, pass: 2, info: 3 } as const
  return [...(selfCheck.value?.checks || [])].sort((a, b) => order[a.state] - order[b.state])
})
const entries = computed(() => [...(egress.value?.entries || [])].reverse())
const checkLabel = (id: string) => { const key = `chat.cleanRoomPanel.checks.${id}`; const text = t(key); return text === key ? id : text }
const time = (iso: string) => { try { return new Date(iso).toLocaleTimeString() } catch { return iso } }

function toggle() { expanded.value = !expanded.value }
defineExpose({ toggle, expanded })
</script>

<template>
  <section v-if="loaded" class="cleanroom-panel" :class="`cleanroom-panel--${tone}`" data-theme-surface="card" data-testid="cleanroom-panel">
    <button type="button" class="cleanroom-summary" :aria-expanded="expanded" aria-controls="cleanroom-details" data-testid="cleanroom-summary" @click="toggle">
      <span class="cleanroom-dot" aria-hidden="true" />
      <span class="cleanroom-summary-text">
        <strong>{{ checkSummary }}</strong>
        <span v-if="leakCount" class="cleanroom-summary-part cleanroom-text-warn" data-testid="cleanroom-leak-count">{{ t('chat.cleanRoomPanel.leakCount', { n: leakCount }) }}</span>
        <span v-if="blockedCount" class="cleanroom-summary-part" data-testid="cleanroom-blocked-count">{{ t('chat.cleanRoomPanel.blockedCount', { n: blockedCount }) }}</span>
      </span>
      <svg class="cleanroom-chevron" :class="{ open: expanded }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>

    <div v-if="expanded" id="cleanroom-details" class="cleanroom-details">
      <div v-if="leaks" class="cleanroom-section" data-testid="cleanroom-leaks">
        <div class="cleanroom-section-head"><h4>{{ t('chat.cleanRoomPanel.folder') }}</h4></div>
        <template v-if="leakCount">
          <p class="cleanroom-text-warn">{{ t('chat.cleanRoomPanel.leaksHint') }}</p>
          <ul class="cleanroom-list cleanroom-leak-list">
            <li v-for="finding in leaks.findings" :key="finding.path" class="cleanroom-item--warn">
              <span class="cleanroom-label cleanroom-code">{{ finding.path }}</span>
              <span class="cleanroom-detail">{{ t(`chat.cleanRoomPanel.kinds.${finding.kind}`) }}</span>
            </li>
          </ul>
          <p v-if="leaks.truncated" class="cleanroom-muted">{{ t('chat.cleanRoomPanel.leaksTruncated') }}</p>
        </template>
        <p v-else class="cleanroom-muted">{{ t('chat.cleanRoomPanel.noLeaks', { n: leaks.scanned }) }}</p>
      </div>

      <div class="cleanroom-section" data-testid="cleanroom-egress">
        <div class="cleanroom-section-head">
          <h4>{{ t('chat.cleanRoomPanel.egress') }}</h4>
          <span v-if="egress && egress.chain.chained" class="cleanroom-muted" :class="{ 'cleanroom-text-fail': !egress.chain.ok }" data-testid="cleanroom-chain">
            {{ egress.chain.ok ? t('chat.cleanRoomPanel.chainOk', { n: egress.chain.chained }) : t('chat.cleanRoomPanel.chainBroken', { line: egress.chain.brokenAt }) }}
          </span>
        </div>
        <p v-if="!entries.length" class="cleanroom-muted">{{ t('chat.cleanRoomPanel.egressEmpty') }}</p>
        <ul v-else class="cleanroom-list cleanroom-egress-list">
          <li v-for="(entry, index) in entries" :key="entry.hash || `${entry.time}-${index}`" :class="entry.allowed ? 'cleanroom-item--pass' : 'cleanroom-item--fail'" data-testid="cleanroom-egress-row">
            <span class="cleanroom-state">{{ entry.allowed ? t('chat.cleanRoomPanel.allowed') : t('chat.cleanRoomPanel.blocked') }}</span>
            <span class="cleanroom-label cleanroom-code">{{ entry.host }}:{{ entry.port }}</span>
            <span class="cleanroom-detail">{{ time(entry.time) }}{{ entry.reason ? ` · ${entry.reason}` : '' }}</span>
          </li>
        </ul>
      </div>
      <div class="cleanroom-section" data-testid="cleanroom-selfcheck">
        <div class="cleanroom-section-head">
          <h4>{{ t('chat.cleanRoomPanel.selfCheck') }}</h4>
          <span v-if="selfCheck" class="cleanroom-muted">{{ t('chat.cleanRoomPanel.checkedAt', { time: time(selfCheck.at) }) }}</span>
          <NButton v-if="canRerun" size="tiny" quaternary :loading="rerunning" data-testid="cleanroom-rerun" @click="rerun">{{ t('chat.cleanRoomPanel.rerun') }}</NButton>
        </div>
        <p v-if="!selfCheck" class="cleanroom-muted">{{ t('chat.cleanRoomPanel.checkPendingHint') }}</p>
        <p v-else-if="selfCheck.error" class="cleanroom-text-fail">{{ t('chat.cleanRoomPanel.checkError', { error: selfCheck.error }) }}</p>
        <ul v-else class="cleanroom-list">
          <li v-for="(check, index) in checks" :key="`${check.id}-${index}`" :class="`cleanroom-item--${check.state}`">
            <span class="cleanroom-state">{{ t(`chat.cleanRoomPanel.state_${check.state}`) }}</span>
            <span class="cleanroom-label">{{ checkLabel(check.id) }}</span>
            <span class="cleanroom-detail">{{ check.detail }}</span>
          </li>
        </ul>
      </div>

    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.cleanroom-panel {
  margin: 8px 16px 0;
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  font-size: 12px;
  flex: 0 0 auto;
  max-height: 45vh;
  overflow: auto;
}

.cleanroom-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; border-radius: var(--radius-component, 8px); }
}

.cleanroom-summary-text { display: flex; flex-wrap: wrap; gap: 4px 12px; flex: 1; min-width: 0; }
.cleanroom-summary-part { color: $text-secondary; }
.cleanroom-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: $info; }
.cleanroom-panel--pass .cleanroom-dot { background: $success; }
.cleanroom-panel--warn .cleanroom-dot { background: $warning; }
.cleanroom-panel--fail .cleanroom-dot { background: $error; }
.cleanroom-chevron { flex: 0 0 auto; transition: transform $transition-fast; &.open { transform: rotate(180deg); } }

.cleanroom-details { padding: 0 10px 10px; display: grid; gap: 10px; }
.cleanroom-section { display: grid; gap: 4px; min-width: 0; }
.cleanroom-section-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  h4 { margin: 0; font-size: 12px; font-weight: 600; }
}
.cleanroom-section p { margin: 0; }
.cleanroom-muted { color: $text-muted; }
.cleanroom-text-warn { color: $warning; }
.cleanroom-text-fail { color: $error; }
.cleanroom-code { font-family: var(--font-code, $font-code); }

.cleanroom-list {
  list-style: none; margin: 0; padding: 0; display: grid; gap: 2px;
  li { display: grid; grid-template-columns: 56px minmax(120px, max-content) minmax(0, 1fr); gap: 8px; align-items: baseline; }
}
.cleanroom-egress-list { max-height: 200px; overflow: auto; }
.cleanroom-list.cleanroom-leak-list li { grid-template-columns: minmax(0, max-content) minmax(0, 1fr); }
.cleanroom-state { font-size: 11px; color: $text-muted; }
.cleanroom-item--pass .cleanroom-state { color: $success; }
.cleanroom-item--warn .cleanroom-state { color: $warning; }
.cleanroom-item--fail .cleanroom-state { color: $error; }
.cleanroom-label { overflow-wrap: anywhere; }
.cleanroom-detail { color: $text-secondary; overflow-wrap: anywhere; min-width: 0; }

@media (max-width: $breakpoint-mobile) {
  .cleanroom-panel { margin: 6px 8px 0; }
  .cleanroom-list li { grid-template-columns: 52px minmax(0, 1fr); }
  .cleanroom-list li .cleanroom-detail { grid-column: 2; }
  .cleanroom-list.cleanroom-leak-list li { grid-template-columns: minmax(0, max-content) minmax(0, 1fr); }
  .cleanroom-list.cleanroom-leak-list li .cleanroom-detail { grid-column: auto; }
}
</style>
