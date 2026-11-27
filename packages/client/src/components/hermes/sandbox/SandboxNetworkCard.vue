<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NCheckbox, NInput, NRadio, NRadioGroup, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchNetworkLog, saveEgressRules, type EgressCall, type EgressRules } from '@/api/studio/sandbox'

/** What sandboxes with internet may reach through Studio's proxy, and the calls they made (docs/sandbox.md). */

const { t } = useI18n()
const toast = useMessage()
const mode = ref<EgressRules['mode']>('allowlist')
const allow = ref('')
const block = ref('')
const calls = ref<EgressCall[]>([])
const onlyBlocked = ref(false)
const loadError = ref('')
const saving = ref(false)
const loaded = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

function setRules(rules: EgressRules) {
  mode.value = rules.mode
  allow.value = rules.allow.join('\n')
  block.value = rules.block.join('\n')
}

async function load(withRules = false) {
  try {
    const out = await fetchNetworkLog({ blocked: onlyBlocked.value, limit: 100 })
    calls.value = out.calls
    if (withRules || !loaded.value) setRules(out.rules)
    loaded.value = true
    loadError.value = ''
  } catch (error) { loadError.value = (error as Error).message }
}

async function save() {
  saving.value = true
  try {
    const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)
    setRules((await saveEgressRules({ mode: mode.value, allow: lines(allow.value), block: lines(block.value) })).rules)
    toast.success(t('sandbox.net.saved'))
  } catch (error) { toast.error(t('sandbox.net.saveFailed', { error: (error as Error).message })) } finally { saving.value = false }
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const shown = computed(() => calls.value.slice(0, 100))

onMounted(() => { void load(true); timer = setInterval(() => { void load() }, 15000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section class="net-card" data-theme-surface="card" data-testid="sandbox-network-card">
    <div class="net-head">
      <h3>{{ t('sandbox.net.title') }}</h3>
      <NButton size="small" secondary @click="load()">{{ t('sandbox.refresh') }}</NButton>
    </div>
    <p class="lab-muted">{{ t('sandbox.net.intro') }}</p>
    <p v-if="loadError" class="lab-error" role="alert">{{ t('sandbox.net.loadFailed', { error: loadError }) }}</p>

    <fieldset class="net-rules">
      <legend>{{ t('sandbox.net.mode') }}</legend>
      <NRadioGroup v-model:value="mode" name="sandbox-egress-mode">
        <div class="net-modes">
          <NRadio value="allowlist">{{ t('sandbox.net.allowlist') }}</NRadio>
          <NRadio value="blocklist">{{ t('sandbox.net.blocklist') }}</NRadio>
          <NRadio value="log">{{ t('sandbox.net.log') }}</NRadio>
        </div>
      </NRadioGroup>
      <label v-if="mode === 'allowlist'" class="net-field">
        <span>{{ t('sandbox.net.allow') }}</span>
        <NInput v-model:value="allow" type="textarea" :autosize="{ minRows: 4, maxRows: 12 }" data-testid="sandbox-egress-allow" />
      </label>
      <label v-if="mode !== 'log'" class="net-field">
        <span>{{ t('sandbox.net.block') }}</span>
        <NInput v-model:value="block" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" data-testid="sandbox-egress-block" />
      </label>
      <p class="lab-muted">{{ t('sandbox.net.lanNote') }}</p>
      <div><NButton type="primary" size="small" :loading="saving" data-testid="sandbox-egress-save" @click="save">{{ t('sandbox.net.save') }}</NButton></div>
    </fieldset>

    <div class="net-head">
      <h4>{{ t('sandbox.net.calls') }}</h4>
      <NCheckbox v-model:checked="onlyBlocked" @update:checked="load()">{{ t('sandbox.net.onlyBlocked') }}</NCheckbox>
    </div>
    <p v-if="!shown.length" class="lab-muted" role="status">{{ t('sandbox.net.noCalls') }}</p>
    <ul v-else class="net-calls" aria-live="polite">
      <li v-for="(call, i) in shown" :key="`${call.time}-${i}`" class="net-call" data-testid="sandbox-call">
        <span class="lab-muted">{{ time(call.time) }}</span>
        <code>{{ call.sandbox || call.ip }}</code>
        <span class="lab-badge" :data-allowed="call.allowed">{{ call.allowed ? t('sandbox.net.allowed') : t('sandbox.net.refused') }}</span>
        <code class="net-host">{{ call.host }}:{{ call.port }}</code>
        <span class="lab-muted">{{ call.result }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.net-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  overflow-wrap: anywhere;
}
.net-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.net-head h3, .net-head h4 { margin: 0; }
.net-rules { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 10px; border: var(--border-width, 1px) solid $border-light; border-radius: var(--radius-component, 8px); }
.net-rules legend { padding: 0 4px; font-weight: 600; }
.net-modes { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.net-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.lab-muted { margin: 0; font-size: 12px; color: $text-muted; overflow-wrap: anywhere; }
.lab-error { margin: 0; color: $error; }
.net-calls { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; max-height: 360px; overflow-y: auto; }
.net-call { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 4px 0; border-top: var(--border-width, 1px) solid $border-light; }
.net-host { font-weight: 600; }
.lab-badge {
  padding: 0 6px;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  color: $accent-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 9px;
  &[data-allowed="false"] { color: $error; }
}
</style>
