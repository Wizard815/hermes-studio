<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, NInputNumber, NSelect, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchCleanRoomSettings, saveCleanRoomSettings, type CleanRoomSettings } from '@/api/studio/watcher'
import SettingRow from './SettingRow.vue'

/** Settings → Clean rooms (docs/cleanroom.md): the walls and checks every clean-room chat gets. */
const CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'NET_BIND_SERVICE', 'SYS_CHROOT', 'AUDIT_WRITE', 'SETFCAP', 'MKNOD', 'NET_RAW']
const SWITCHES = ['readOnlyRoot', 'dropAllCaps', 'selfCheck', 'leakCheck', 'egressLog', 'auditChain', 'allowWebTools'] as const

const { t } = useI18n()
const message = useMessage()
const saved = ref<CleanRoomSettings | null>(null)
const form = ref<CleanRoomSettings | null>(null)
const hosts = ref('')
const saving = ref(false)

function load(value: CleanRoomSettings) {
  saved.value = value
  form.value = structuredClone(value)
  hosts.value = value.allowHosts.join('\n')
}

onMounted(async () => {
  try { load(await fetchCleanRoomSettings()) } catch { message.error(t('cleanRooms.loadFailed')) }
})

const draft = computed<CleanRoomSettings | null>(() => form.value && {
  ...form.value,
  allowHosts: hosts.value.split(/[\s,]+/).map(host => host.trim().toLowerCase()).filter(Boolean),
})
const changed = computed(() => !!draft.value && !!saved.value && JSON.stringify(draft.value) !== JSON.stringify(saved.value))

async function save() {
  if (!draft.value) return
  saving.value = true
  try {
    load(await saveCleanRoomSettings(draft.value))
    message.success(t('cleanRooms.saved'))
  } catch {
    message.error(t('cleanRooms.saveFailed'))
  } finally {
    saving.value = false
  }
}

const networkOptions = computed(() => (['allowlist', 'studio', 'internet'] as const).map(value => ({ value, label: t(`cleanRooms.network.${value}`) })))
const userOptions = computed(() => (['auto', 'room', 'root'] as const).map(value => ({ value, label: t(`cleanRooms.user.${value}`) })))
const capabilityOptions = CAPABILITIES.map(value => ({ value, label: value }))
</script>

<template>
  <section class="settings-section clean-room-settings" data-testid="clean-room-settings">
    <h3 class="section-title">{{ t('cleanRooms.title') }}</h3>
    <p class="section-hint">{{ t('cleanRooms.description') }}</p>
    <template v-if="form">
      <h4 class="sub-title">{{ t('cleanRooms.networkTitle') }}</h4>
      <SettingRow :label="t('cleanRooms.networkLabel')" :hint="t(`cleanRooms.networkHint.${form.network}`)">
        <NSelect v-model:value="form.network" :options="networkOptions" size="small" class="clean-room-select" data-testid="clean-room-network" />
      </SettingRow>
      <div v-if="form.network === 'allowlist'" class="clean-room-hosts">
        <label for="clean-room-hosts" class="setting-label">{{ t('cleanRooms.allowHosts') }}</label>
        <p class="section-hint">{{ t('cleanRooms.allowHostsHint') }}</p>
        <NInput id="clean-room-hosts" v-model:value="hosts" type="textarea" :autosize="{ minRows: 4, maxRows: 10 }" data-testid="clean-room-hosts" />
      </div>

      <h4 class="sub-title">{{ t('cleanRooms.wallsTitle') }}</h4>
      <SettingRow v-for="key in SWITCHES" :key="key" :label="t(`cleanRooms.field.${key}`)" :hint="t(`cleanRooms.hint.${key}`)">
        <NSwitch v-model:value="form[key]" :aria-label="t(`cleanRooms.field.${key}`)" :data-testid="`clean-room-${key}`" />
      </SettingRow>
      <SettingRow :label="t('cleanRooms.field.user')" :hint="t(`cleanRooms.userHint.${form.user}`)">
        <NSelect v-model:value="form.user" :options="userOptions" size="small" class="clean-room-select" data-testid="clean-room-user" />
      </SettingRow>
      <SettingRow :label="t('cleanRooms.field.capAdd')" :hint="t('cleanRooms.hint.capAdd')">
        <NSelect v-model:value="form.capAdd" :options="capabilityOptions" multiple clearable size="small" class="clean-room-select" :placeholder="t('cleanRooms.none')" data-testid="clean-room-capadd" />
      </SettingRow>

      <h4 class="sub-title">{{ t('cleanRooms.containerTitle') }}</h4>
      <SettingRow :label="t('cleanRooms.field.image')" :hint="t('cleanRooms.hint.image')">
        <NInput v-model:value="form.image" size="small" class="clean-room-select" data-testid="clean-room-image" />
      </SettingRow>
      <SettingRow :label="t('cleanRooms.field.cpus')">
        <NInputNumber v-model:value="form.cpus" :min="0.25" :max="64" :step="0.5" size="small" class="clean-room-number" />
      </SettingRow>
      <SettingRow :label="t('cleanRooms.field.memory')" :hint="t('cleanRooms.hint.memory')">
        <NInput v-model:value="form.memory" size="small" class="clean-room-number" />
      </SettingRow>
      <SettingRow :label="t('cleanRooms.field.pids')" :hint="t('cleanRooms.hint.pids')">
        <NInputNumber v-model:value="form.pids" :min="64" :max="100000" :step="64" size="small" class="clean-room-number" />
      </SettingRow>

      <div class="clean-room-actions">
        <span class="section-hint" role="status" aria-live="polite">{{ changed ? t('cleanRooms.unsaved') : '' }}</span>
        <NButton :disabled="!changed" @click="saved && load(saved)">{{ t('cleanRooms.undo') }}</NButton>
        <NButton type="primary" :disabled="!changed" :loading="saving" data-testid="clean-room-save" @click="save">{{ t('common.save') }}</NButton>
      </div>
    </template>
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
  margin: 20px 0 4px;
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.section-hint {
  margin: 0 0 10px;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
}

.setting-label {
  color: $text-primary;
  font-size: 13px;
}

.clean-room-hosts {
  padding: 8px 0 12px;
  border-bottom: var(--border-width, 1px) solid $border-light;

  .section-hint { margin: 2px 0 6px; color: $text-muted; font-size: 12px; }
}

.clean-room-select { width: 260px; }
.clean-room-number { width: 160px; }

.clean-room-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0;

  .section-hint { margin: 0 auto 0 0; }
}

@media (max-width: 640px) {
  .clean-room-select { width: 100%; }
}
</style>
