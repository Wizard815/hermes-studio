<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NInput, NInputNumber, NPopconfirm, NSelect, NSwitch, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import SettingRow from './SettingRow.vue'
import HermesActionLog from './HermesActionLog.vue'
import { useHermesAction } from './useHermesAction'
import {
  addHook, checkForUpdate, deleteHook, downloadBackup, formatBytes, listCheckpoints, listHooks, pruneCheckpoints,
  runBackup, runDoctor, runImport, uploadBackup, runPromptSize, runSecurityAudit,
  type HermesHook, type UpdateCheck,
} from '@/api/hermes/agent-tools'

const { t } = useI18n()
const message = useMessage()

// ---- Health checks ----
const doctor = useHermesAction('doctor')
const audit = useHermesAction('security-audit')
const promptSize = useHermesAction('prompt-size')

// ---- Backup / restore ----
const backup = useHermesAction('backup')
const backupArchive = ref('')
const restore = useHermesAction('import')
const restorePath = ref('')
const restoreForce = ref(true)
const uploadInput = ref<HTMLInputElement | null>(null)

function pickUpload() {
  uploadInput.value?.click()
}

async function onUploadPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!window.confirm(t('hermesTools.maintenance.restoreConfirm'))) return
  await restore.run(() => uploadBackup(file, restoreForce.value))
}

async function startBackup() {
  backupArchive.value = ''
  await backup.run(async () => {
    const result = await runBackup()
    backupArchive.value = result.archive || ''
  })
}

async function download() {
  try {
    await downloadBackup(backupArchive.value)
  } catch (err: any) {
    message.error(err?.message || String(err))
  }
}

// ---- Checkpoints ----
const checkpoints = ref<{ sessions: { session: string; files: number; bytes: number }[]; total_bytes: number } | null>(null)
const prune = useHermesAction('checkpoints-prune')
async function loadCheckpoints() {
  checkpoints.value = await listCheckpoints().catch(() => null)
}
async function startPrune() {
  if (await prune.run(pruneCheckpoints)) setTimeout(loadCheckpoints, 4000)
}

// ---- Hooks ----
const hooks = ref<HermesHook[]>([])
const hookEvents = ref<string[]>([])
const hooksError = ref('')
const newHook = ref({ event: null as string | null, command: '', matcher: '', timeout: null as number | null })
const addingHook = ref(false)

async function loadHooks() {
  hooksError.value = ''
  try {
    const data = await listHooks()
    hooks.value = data.hooks
    hookEvents.value = data.valid_events
  } catch (err: any) {
    hooksError.value = err?.message || String(err)
  }
}

async function createHook() {
  if (!newHook.value.event || !newHook.value.command.trim()) return
  addingHook.value = true
  try {
    await addHook({
      event: newHook.value.event,
      command: newHook.value.command.trim(),
      matcher: newHook.value.matcher.trim() || undefined,
      timeout: newHook.value.timeout,
      approve: true,
    })
    newHook.value = { event: null, command: '', matcher: '', timeout: null }
    message.success(t('hermesTools.maintenance.hookAdded'))
    await loadHooks()
  } catch (err: any) {
    message.error(err?.message || t('settings.saveFailed'))
  } finally {
    addingHook.value = false
  }
}

async function removeHook(hook: HermesHook) {
  try {
    await deleteHook(hook.event, hook.command)
    await loadHooks()
  } catch (err: any) {
    message.error(err?.message || t('settings.saveFailed'))
  }
}

// ---- Updates ----
const update = ref<UpdateCheck | null>(null)
const checking = ref(false)
async function check(force = false) {
  checking.value = true
  try {
    update.value = await checkForUpdate(force)
  } catch (err: any) {
    message.error(err?.message || String(err))
  } finally {
    checking.value = false
  }
}

onMounted(() => {
  void loadCheckpoints()
  void loadHooks()
  void check()
})
</script>

<template>
  <section class="settings-section">
    <h3 class="section-title">{{ t('hermesTools.maintenance.healthTitle') }}</h3>
    <p class="section-hint">{{ t('hermesTools.maintenance.healthHint') }}</p>
    <SettingRow :label="t('hermesTools.maintenance.doctor')" :hint="t('hermesTools.maintenance.doctorHint')">
      <NButton size="small" data-testid="run-doctor" :loading="doctor.running.value" @click="doctor.run(runDoctor)">{{ t('hermesTools.maintenance.run') }}</NButton>
    </SettingRow>
    <HermesActionLog :lines="doctor.lines.value" :running="doctor.running.value" :exit-code="doctor.exitCode.value" :finished="doctor.finished.value" :error="doctor.error.value" />
    <SettingRow :label="t('hermesTools.maintenance.audit')" :hint="t('hermesTools.maintenance.auditHint')">
      <NButton size="small" :loading="audit.running.value" @click="audit.run(runSecurityAudit)">{{ t('hermesTools.maintenance.run') }}</NButton>
    </SettingRow>
    <HermesActionLog :lines="audit.lines.value" :running="audit.running.value" :exit-code="audit.exitCode.value" :finished="audit.finished.value" :error="audit.error.value" />
    <SettingRow :label="t('hermesTools.maintenance.promptSize')" :hint="t('hermesTools.maintenance.promptSizeHint')">
      <NButton size="small" :loading="promptSize.running.value" @click="promptSize.run(runPromptSize)">{{ t('hermesTools.maintenance.run') }}</NButton>
    </SettingRow>
    <HermesActionLog :lines="promptSize.lines.value" :running="promptSize.running.value" :exit-code="promptSize.exitCode.value" :finished="promptSize.finished.value" :error="promptSize.error.value" />
  </section>

  <section class="settings-section">
    <h3 class="section-title">{{ t('hermesTools.maintenance.backupTitle') }}</h3>
    <p class="section-hint">{{ t('hermesTools.maintenance.backupHint') }}</p>
    <SettingRow :label="t('hermesTools.maintenance.backup')" :hint="t('hermesTools.maintenance.backupRowHint')">
      <div class="row-actions">
        <NButton v-if="backupArchive && backup.finished.value && backup.exitCode.value === 0" size="small" type="primary" @click="download">{{ t('hermesTools.maintenance.download') }}</NButton>
        <NButton size="small" :loading="backup.running.value" @click="startBackup">{{ t('hermesTools.maintenance.makeBackup') }}</NButton>
      </div>
    </SettingRow>
    <HermesActionLog :lines="backup.lines.value" :running="backup.running.value" :exit-code="backup.exitCode.value" :finished="backup.finished.value" :error="backup.error.value" />
    <SettingRow :label="t('hermesTools.maintenance.restore')" :hint="t('hermesTools.maintenance.restoreHint')">
      <div class="row-actions">
        <NInput v-model:value="restorePath" size="small" class="input-md" :placeholder="t('hermesTools.maintenance.restorePath')" />
        <span class="muted">{{ t('hermesTools.maintenance.overwrite') }}</span>
        <NSwitch v-model:value="restoreForce" size="small" />
        <NPopconfirm @positive-click="restore.run(() => runImport(restorePath.trim(), restoreForce))">
          <template #trigger>
            <NButton size="small" type="warning" :disabled="!restorePath.trim()" :loading="restore.running.value">{{ t('hermesTools.maintenance.restoreButton') }}</NButton>
          </template>
          {{ t('hermesTools.maintenance.restoreConfirm') }}
        </NPopconfirm>
        <NButton size="small" :loading="restore.running.value" @click="pickUpload">{{ t('hermesTools.maintenance.uploadBackup') }}</NButton>
        <input ref="uploadInput" type="file" accept=".zip,application/zip" style="display: none" @change="onUploadPicked">
      </div>
    </SettingRow>
    <HermesActionLog :lines="restore.lines.value" :running="restore.running.value" :exit-code="restore.exitCode.value" :finished="restore.finished.value" :error="restore.error.value" />
  </section>

  <section class="settings-section">
    <h3 class="section-title">{{ t('hermesTools.maintenance.checkpointsTitle') }}</h3>
    <p class="section-hint">{{ t('hermesTools.maintenance.checkpointsHint') }}</p>
    <SettingRow
      :label="t('hermesTools.maintenance.checkpointsUsage', { count: checkpoints?.sessions.length ?? 0, size: formatBytes(checkpoints?.total_bytes ?? 0) })"
      :hint="t('hermesTools.maintenance.pruneHint')"
    >
      <div class="row-actions">
        <NButton size="small" quaternary @click="loadCheckpoints">{{ t('hermesTools.common.refresh') }}</NButton>
        <NPopconfirm @positive-click="startPrune">
          <template #trigger>
            <NButton size="small" :loading="prune.running.value" :disabled="!checkpoints?.sessions.length">{{ t('hermesTools.maintenance.prune') }}</NButton>
          </template>
          {{ t('hermesTools.maintenance.pruneConfirm') }}
        </NPopconfirm>
      </div>
    </SettingRow>
    <div v-if="checkpoints?.sessions.length" class="checkpoint-list">
      <div v-for="cp in checkpoints.sessions" :key="cp.session" class="checkpoint-row muted">
        <span class="mono">{{ cp.session }}</span>
        <span>{{ t('hermesTools.maintenance.files', { count: cp.files }) }} · {{ formatBytes(cp.bytes) }}</span>
      </div>
    </div>
    <HermesActionLog :lines="prune.lines.value" :running="prune.running.value" :exit-code="prune.exitCode.value" :finished="prune.finished.value" :error="prune.error.value" />
  </section>

  <section class="settings-section">
    <h3 class="section-title">{{ t('hermesTools.maintenance.hooksTitle') }}</h3>
    <p class="section-hint">{{ t('hermesTools.maintenance.hooksHint') }}</p>
    <p v-if="hooksError" class="muted">{{ t('hermesTools.common.unavailable') }} {{ hooksError }}</p>
    <p v-else-if="!hooks.length" class="muted">{{ t('hermesTools.maintenance.noHooks') }}</p>
    <SettingRow v-for="hook in hooks" :key="`${hook.event}:${hook.command}`" :label="hook.command" :hint="[hook.event, hook.matcher].filter(Boolean).join(' · ')">
      <div class="row-actions">
        <NTag v-if="!hook.allowed" size="small" type="warning" :bordered="false">{{ t('hermesTools.maintenance.notApproved') }}</NTag>
        <NTag v-if="!hook.executable" size="small" type="warning" :bordered="false">{{ t('hermesTools.maintenance.notExecutable') }}</NTag>
        <NPopconfirm @positive-click="removeHook(hook)">
          <template #trigger>
            <NButton size="small" quaternary type="error">{{ t('hermesTools.common.remove') }}</NButton>
          </template>
          {{ t('hermesTools.maintenance.removeHookConfirm') }}
        </NPopconfirm>
      </div>
    </SettingRow>
    <div class="hook-form">
      <NSelect v-model:value="newHook.event" size="small" filterable :options="hookEvents.map(e => ({ label: e, value: e }))" :placeholder="t('hermesTools.maintenance.hookEvent')" />
      <NInput v-model:value="newHook.command" size="small" :placeholder="t('hermesTools.maintenance.hookCommand')" />
      <NInput v-model:value="newHook.matcher" size="small" :placeholder="t('hermesTools.maintenance.hookMatcher')" />
      <NInputNumber v-model:value="newHook.timeout" size="small" :min="1" :placeholder="t('hermesTools.maintenance.hookTimeout')" />
      <NButton size="small" type="primary" :loading="addingHook" :disabled="!newHook.event || !newHook.command.trim()" @click="createHook">{{ t('hermesTools.maintenance.addHook') }}</NButton>
    </div>
    <p class="muted">{{ t('hermesTools.maintenance.hookRestartNote') }}</p>
  </section>

  <section class="settings-section">
    <h3 class="section-title">{{ t('hermesTools.maintenance.updateTitle') }}</h3>
    <SettingRow
      :label="t('hermesTools.maintenance.version', { version: update?.current_version || '—' })"
      :hint="update?.message || (update?.update_available ? t('hermesTools.maintenance.updateAvailable', { count: update.behind ?? '?' }) : '')"
    >
      <div class="row-actions">
        <NTag v-if="update?.update_available" size="small" type="info" :bordered="false">{{ t('hermesTools.maintenance.newVersion') }}</NTag>
        <NButton size="small" :loading="checking" @click="check(true)">{{ t('hermesTools.maintenance.checkNow') }}</NButton>
      </div>
    </SettingRow>
    <p v-if="update?.update_available && update.update_command" class="muted">{{ t('hermesTools.maintenance.updateHow') }} <code>{{ update.update_command }}</code></p>
  </section>
</template>

<style scoped lang="scss">
@use './hermes-tools' as *;
@use '@/styles/variables' as vars;

.checkpoint-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
  padding: 4px 0 8px;
}

.checkpoint-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.mono {
  font-family: vars.$font-code;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hook-form {
  display: grid;
  grid-template-columns: minmax(160px, 1.2fr) minmax(180px, 2fr) minmax(120px, 1fr) 110px auto;
  gap: 8px;
  margin: 8px 0;

  @media (max-width: vars.$breakpoint-mobile) {
    grid-template-columns: 1fr;
  }
}
</style>
