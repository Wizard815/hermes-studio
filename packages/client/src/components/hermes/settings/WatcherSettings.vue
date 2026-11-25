<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, NInputNumber, NSelect, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchCronApprovalMode, fetchTrustRules, fetchWatcherSettings, removeTrustRule, saveCronApprovalMode, saveWatcherSettings,
} from '@/api/studio/watcher'
import { fetchAgentWorkSettings } from '@/api/studio/agent-work'
import TrustRuleDialog from '@/components/watcher/TrustRuleDialog.vue'
import SettingRow from './SettingRow.vue'
import {
  DEFAULT_WATCHER_SETTINGS, WATCHER_AGE_LIMITS, WATCHER_HISTORY_LIMITS, WATCHER_KINDS,
  type CronApprovalMode, type TrustRule, type WatcherExtraStatus, type WatcherKind, type WatcherSettings,
} from '../../../../../shared/watcher'

/** Settings → Watcher (docs/watcher.md): what makes an alert, what goes to Mattermost, trust rules, extras. */
const { t, locale } = useI18n()
const message = useMessage()
const settings = ref<WatcherSettings>(structuredClone(DEFAULT_WATCHER_SETTINGS))
const extras = ref<WatcherExtraStatus[]>([])
const rules = ref<TrustRule[]>([])
const channel = ref('')
const cronMode = ref<CronApprovalMode>('deny')
const loaded = ref(false)
const adding = ref(false)
const pipelockUrl = ref('')
let timer = 0

onMounted(async () => {
  try {
    const [loadedSettings, loadedRules] = await Promise.all([fetchWatcherSettings(), fetchTrustRules()])
    settings.value = loadedSettings.settings
    extras.value = loadedSettings.extras
    pipelockUrl.value = loadedSettings.settings.extras.pipelock.proxyUrl
    rules.value = loadedRules.rules
    loaded.value = true
  } catch {
    message.error(t('watcher.settings.loadFailed'))
  }
  fetchAgentWorkSettings().then(value => { channel.value = value.mattermost.channel }).catch(() => undefined)
  fetchCronApprovalMode().then(value => { cronMode.value = value.mode }).catch(() => undefined)
})

async function save(patch: Record<string, unknown>) {
  try {
    const result = await saveWatcherSettings(patch)
    settings.value = result.settings
    extras.value = result.extras
    message.success(t('watcher.settings.saved'))
  } catch {
    message.error(t('watcher.settings.saveFailed'))
  }
}

function setKind(kind: WatcherKind, field: 'alert' | 'mattermost', value: boolean) {
  settings.value.kinds[kind] = { ...settings.value.kinds[kind], [field]: value }
  void save({ kinds: { [kind]: { [field]: value } } })
}

function setNumber(field: 'historySize' | 'maxAgeDays', value: number | null) {
  if (value == null) return
  settings.value = { ...settings.value, [field]: value }
  window.clearTimeout(timer)
  timer = window.setTimeout(() => { void save({ [field]: value }) }, 600)
}

function setExtra(id: 'pipelock' | 'innerwarden' | 'langfuse', enabled: boolean) {
  void save({ extras: { [id]: id === 'pipelock' ? { enabled, proxyUrl: pipelockUrl.value } : { enabled } } })
}

function savePipelockUrl() {
  void save({ extras: { pipelock: { enabled: settings.value.extras.pipelock.enabled, proxyUrl: pipelockUrl.value.trim() } } })
}

async function setCron(mode: CronApprovalMode) {
  try {
    cronMode.value = (await saveCronApprovalMode(mode)).mode
    message.success(t('watcher.settings.saved'))
  } catch {
    message.error(t('watcher.settings.saveFailed'))
  }
}

async function remove(rule: TrustRule) {
  try { rules.value = (await removeTrustRule(rule.id)).rules } catch { message.error(t('watcher.actionFailed')) }
}

async function reloadRules() {
  try { rules.value = (await fetchTrustRules()).rules } catch { /* the list stays */ }
}

const extra = (id: string) => extras.value.find(item => item.id === id)
const cronOptions = computed(() => [
  { value: 'deny', label: t('watcher.settings.cronDeny') },
  { value: 'approve', label: t('watcher.settings.cronApprove') },
])
function expires(rule: TrustRule): string {
  return rule.expiresAt ? new Date(rule.expiresAt).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' }) : t('watcher.trust.expiry.never')
}
</script>

<template>
  <section class="settings-section watcher-settings" data-testid="watcher-settings">
    <h3 class="section-title">{{ t('watcher.settings.title') }}</h3>
    <p class="section-hint">{{ t('watcher.settings.description') }}</p>

    <h4 class="sub-title">{{ t('watcher.settings.kindsTitle') }}</h4>
    <p class="section-hint">
      {{ channel ? t('watcher.settings.mattermostChannel', { channel }) : t('watcher.settings.mattermostNone') }}
    </p>
    <div class="watcher-kinds" role="table" :aria-label="t('watcher.settings.kindsTitle')">
      <div class="watcher-kinds__row watcher-kinds__head" role="row">
        <span role="columnheader">{{ t('watcher.settings.kindColumn') }}</span>
        <span role="columnheader">{{ t('watcher.settings.bellColumn') }}</span>
        <span role="columnheader">{{ t('watcher.settings.mattermostColumn') }}</span>
      </div>
      <div v-for="kind in WATCHER_KINDS" :key="kind" class="watcher-kinds__row" role="row" :data-testid="`watcher-kind-${kind}`">
        <span role="cell" class="watcher-kinds__label">{{ t(`watcher.kind.${kind}`) }}<small>{{ t(`watcher.kindHint.${kind}`) }}</small></span>
        <span role="cell"><NSwitch :value="!!settings.kinds[kind]?.alert" :disabled="!loaded" :aria-label="`${t(`watcher.kind.${kind}`)}: ${t('watcher.settings.bellColumn')}`" :data-testid="`watcher-kind-${kind}-alert`" @update:value="(value: boolean) => setKind(kind, 'alert', value)" /></span>
        <span role="cell"><NSwitch :value="!!settings.kinds[kind]?.mattermost" :disabled="!loaded" :aria-label="`${t(`watcher.kind.${kind}`)}: ${t('watcher.settings.mattermostColumn')}`" :data-testid="`watcher-kind-${kind}-mattermost`" @update:value="(value: boolean) => setKind(kind, 'mattermost', value)" /></span>
      </div>
    </div>

    <SettingRow :label="t('watcher.settings.historySize')" :hint="t('watcher.settings.historySizeHint')">
      <NInputNumber :value="settings.historySize" :min="WATCHER_HISTORY_LIMITS.min" :max="WATCHER_HISTORY_LIMITS.max" :step="50" size="small" class="watcher-number" :disabled="!loaded" data-testid="watcher-history-size" @update:value="(value: number | null) => setNumber('historySize', value)" />
    </SettingRow>
    <SettingRow :label="t('watcher.settings.maxAge')" :hint="t('watcher.settings.maxAgeHint')">
      <NInputNumber :value="settings.maxAgeDays" :min="WATCHER_AGE_LIMITS.min" :max="WATCHER_AGE_LIMITS.max" size="small" class="watcher-number" :disabled="!loaded" @update:value="(value: number | null) => setNumber('maxAgeDays', value)">
        <template #suffix>{{ t('watcher.settings.days') }}</template>
      </NInputNumber>
    </SettingRow>

    <h4 class="sub-title">{{ t('watcher.settings.trustTitle') }}</h4>
    <p class="section-hint">{{ t('watcher.settings.trustHint') }}</p>
    <ul v-if="rules.length" class="watcher-rules" data-testid="watcher-rules">
      <li v-for="rule in rules" :key="rule.id" class="watcher-rule" data-testid="watcher-rule">
        <div class="watcher-rule__text">
          <code>{{ rule.pattern }}</code>
          <span>{{ t(`watcher.trust.kind.${rule.kind}`) }} · {{ t(`watcher.trust.scope.${rule.scope}`) }}: {{ rule.target }} · {{ t('watcher.settings.expires', { when: expires(rule) }) }}</span>
        </div>
        <NButton size="small" quaternary :aria-label="t('watcher.settings.removeRule', { pattern: rule.pattern })" data-testid="watcher-rule-remove" @click="remove(rule)">{{ t('watcher.settings.remove') }}</NButton>
      </li>
    </ul>
    <p v-else class="section-hint watcher-empty">{{ t('watcher.settings.noRules') }}</p>
    <NButton size="small" data-testid="watcher-add-rule" @click="adding = true">{{ t('watcher.settings.addRule') }}</NButton>
    <TrustRuleDialog v-if="adding" @close="adding = false" @saved="reloadRules" />

    <h4 class="sub-title">{{ t('watcher.settings.modesTitle') }}</h4>
    <p class="section-hint">{{ t('watcher.settings.modesHint') }}</p>
    <SettingRow :label="t('watcher.settings.cron')" :hint="t('watcher.settings.cronHint')">
      <NSelect :value="cronMode" :options="cronOptions" size="small" class="watcher-select" data-testid="watcher-cron-mode" @update:value="setCron" />
    </SettingRow>

    <h4 class="sub-title">{{ t('watcher.settings.extrasTitle') }}</h4>
    <p class="section-hint">{{ t('watcher.settings.extrasHint') }}</p>
    <SettingRow v-for="id in (['pipelock', 'innerwarden', 'langfuse'] as const)" :key="id" :label="t(`watcher.extra.${id}`)" :hint="t(`watcher.extraHint.${id}`)">
      <div class="watcher-extra" :data-testid="`watcher-extra-${id}`">
        <NSwitch :value="settings.extras[id].enabled" :disabled="!loaded" :aria-label="t(`watcher.extra.${id}`)" @update:value="(value: boolean) => setExtra(id, value)" />
        <span class="watcher-extra__state" :class="{ 'is-ok': extra(id)?.available }">{{ extra(id)?.available ? t('watcher.settings.available') : t('watcher.settings.notAvailable') }}</span>
      </div>
    </SettingRow>
    <div class="watcher-extra-details">
      <p v-for="item in extras" :key="item.id" class="section-hint" :data-testid="`watcher-extra-${item.id}-detail`"><strong>{{ t(`watcher.extra.${item.id}`) }}:</strong> {{ item.detail }}</p>
      <div class="watcher-pipelock-url">
        <label for="watcher-pipelock-url" class="setting-label">{{ t('watcher.settings.pipelockUrl') }}</label>
        <NInput id="watcher-pipelock-url" v-model:value="pipelockUrl" size="small" placeholder="http://127.0.0.1:8888" :disabled="!loaded" />
        <NButton size="small" :disabled="!loaded || pipelockUrl.trim() === settings.extras.pipelock.proxyUrl" @click="savePipelockUrl">{{ t('common.save') }}</NButton>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.section-title {
  margin: 0 0 6px;
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  color: $text-primary;
}

.sub-title {
  margin: 22px 0 4px;
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  font-weight: 600;
  color: $text-primary;
}

.section-hint {
  margin: 0 0 10px;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
}

.watcher-kinds {
  display: flex;
  flex-direction: column;
  margin-bottom: 8px;
  border-top: var(--border-width, 1px) solid $border-light;
}

.watcher-kinds__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px 110px;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: var(--border-width, 1px) solid $border-light;
  font-size: 13px;
  color: $text-primary;

  > span:not(:first-child) { justify-self: center; }
}

.watcher-kinds__head {
  color: $text-muted;
  font-size: 12px;
}

.watcher-kinds__label small {
  display: block;
  margin-top: 2px;
  color: $text-muted;
  font-size: 12px;
}

.watcher-number { width: 160px; }
.watcher-select { width: 280px; }

.watcher-rules {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
  border-top: var(--border-width, 1px) solid $border-light;
}

.watcher-rule {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.watcher-rule__text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: $text-muted;

  code {
    color: $text-primary;
    font-family: $font-code;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
}

.watcher-empty { color: $text-muted; }

.watcher-extra {
  display: flex;
  align-items: center;
  gap: 10px;
}

.watcher-extra__state {
  min-width: 96px;
  color: $text-muted;
  font-size: 12px;

  &.is-ok { color: $success; }
}

.watcher-extra-details {
  margin-top: 8px;
}

.watcher-pipelock-url {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;

  .setting-label {
    color: $text-primary;
    font-size: 13px;
  }

  :deep(.n-input) { width: 260px; }
}

@media (max-width: 640px) {
  .watcher-kinds__row { grid-template-columns: minmax(0, 1fr) 56px 76px; }
  .watcher-select { width: 100%; }
}
</style>
