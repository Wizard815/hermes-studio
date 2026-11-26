<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NCheckbox, NRadioButton, NRadioGroup, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchApprovalAlerts, saveApprovalAlertPrefs, type ApprovalAlertsStatus } from '@/api/studio/approval-alerts'
import {
  APPROVAL_ALERT_KINDS, APPROVAL_ROUTES, DEFAULT_APPROVAL_ALERT_PREFS, routeIncludes,
  type ApprovalAlertKind, type ApprovalAlertPrefs, type ApprovalRoute,
} from '../../../../../shared/approval-alerts'

/** Settings → Watcher → "Where approvals reach you" (docs/approval-alerts.md): the signed-in super admin's own choice. */
const { t } = useI18n()
const message = useMessage()
const router = useRouter()
const prefs = ref<ApprovalAlertPrefs>(structuredClone(DEFAULT_APPROVAL_ALERT_PREFS))
const status = ref<ApprovalAlertsStatus | null>(null)
const loaded = ref(false)
const saving = ref(false)

onMounted(async () => {
  try {
    status.value = await fetchApprovalAlerts()
    prefs.value = status.value.prefs
    loaded.value = true
  } catch {
    message.error(t('approvalAlerts.loadFailed'))
  }
})

async function save(patch: Partial<ApprovalAlertPrefs>) {
  const before: ApprovalAlertPrefs = JSON.parse(JSON.stringify(prefs.value))
  prefs.value = { ...prefs.value, ...patch, kinds: { ...prefs.value.kinds, ...(patch.kinds || {}) } }
  saving.value = true
  try {
    prefs.value = (await saveApprovalAlertPrefs(prefs.value)).prefs
    message.success(t('approvalAlerts.saved'))
  } catch {
    prefs.value = before
    message.error(t('approvalAlerts.saveFailed'))
  } finally {
    saving.value = false
  }
}

function setRoute(route: ApprovalRoute) { void save({ route }) }
function setKind(kind: ApprovalAlertKind, value: boolean) { void save({ kinds: { ...prefs.value.kinds, [kind]: value } }) }

const toMattermost = computed(() => routeIncludes(prefs.value.route, 'mattermost'))
const toAndroid = computed(() => routeIncludes(prefs.value.route, 'android'))
const phones = computed(() => status.value?.devices.length || 0)
</script>

<template>
  <section class="settings-section approval-alerts" data-testid="approval-alerts-settings" aria-labelledby="approval-alerts-title">
    <h3 id="approval-alerts-title" class="section-title">{{ t('approvalAlerts.title') }}</h3>
    <p class="section-hint">{{ t('approvalAlerts.hint') }}</p>

    <div class="approval-alerts__route">
      <span id="approval-alerts-route" class="approval-alerts__label">{{ t('approvalAlerts.route') }}</span>
      <NRadioGroup :value="prefs.route" :disabled="!loaded || saving" aria-labelledby="approval-alerts-route" data-testid="approval-alerts-route" @update:value="setRoute">
        <NRadioButton v-for="route in APPROVAL_ROUTES" :key="route" :value="route" :label="t(`approvalAlerts.routes.${route}`)" :data-testid="`approval-alerts-route-${route}`" />
      </NRadioGroup>
      <p class="section-hint approval-alerts__route-hint" role="status" aria-live="polite" data-testid="approval-alerts-route-hint">{{ t(`approvalAlerts.routeHints.${prefs.route}`) }}</p>
    </div>

    <fieldset class="approval-alerts__kinds" :disabled="!loaded || prefs.route === 'off'">
      <legend class="approval-alerts__label">{{ t('approvalAlerts.kindsTitle') }}</legend>
      <div v-for="kind in APPROVAL_ALERT_KINDS" :key="kind" class="approval-alerts__kind">
        <NCheckbox :checked="prefs.kinds[kind]" :disabled="!loaded || saving || prefs.route === 'off'" :data-testid="`approval-alerts-kind-${kind}`" @update:checked="(value: boolean) => setKind(kind, value)">
          {{ t(`approvalAlerts.kinds.${kind}`) }}
        </NCheckbox>
        <small>{{ t(`approvalAlerts.kindHints.${kind}`) }}</small>
      </div>
    </fieldset>

    <div v-if="loaded" class="approval-alerts__notes">
      <template v-if="toMattermost">
        <p class="section-hint" data-testid="approval-alerts-mattermost-note">
          {{ status?.mattermost.channel ? t('approvalAlerts.mattermostChannel', { channel: status.mattermost.channel }) : t('approvalAlerts.mattermostNone') }}
        </p>
        <p v-if="status?.mattermost.channel && !status.mattermost.buttons" class="section-hint">{{ t('approvalAlerts.mattermostNoButtons') }}</p>
      </template>
      <div v-if="toAndroid" class="approval-alerts__phones" data-testid="approval-alerts-android-note">
        <p class="section-hint">{{ phones ? t('approvalAlerts.phones', { n: phones }) : t('approvalAlerts.noPhone') }}</p>
        <NButton size="small" data-testid="approval-alerts-pair" @click="router.push({ query: { tab: 'android-app' } })">{{ t('approvalAlerts.pairPhone') }}</NButton>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.approval-alerts {
  margin-bottom: 28px;
  padding-bottom: 20px;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.section-title {
  margin: 0 0 6px;
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  color: $text-primary;
}

.section-hint {
  margin: 0 0 10px;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
}

.approval-alerts__label {
  display: block;
  margin-bottom: 6px;
  padding: 0;
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
}

.approval-alerts__route {
  margin: 14px 0 6px;

  :deep(.n-radio-group) { flex-wrap: wrap; }
  :deep(.n-radio-button) { min-height: 36px; display: inline-flex; align-items: center; }
}

.approval-alerts__route-hint { margin-top: 8px; }

.approval-alerts__kinds {
  margin: 12px 0 8px;
  padding: 0;
  border: 0;
  min-width: 0;
}

.approval-alerts__kind {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
  border-bottom: var(--border-width, 1px) solid $border-light;

  :deep(.n-checkbox) { min-height: 28px; align-items: center; }

  small {
    padding-inline-start: 26px;
    color: $text-muted;
    font-size: 12px;
  }
}

.approval-alerts__notes { margin-top: 12px; }

.approval-alerts__phones {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;

  .section-hint { margin: 0; }
}
</style>
