<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NCollapseTransition, NInput, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  applyMattermostSetup, getMattermostSetup, inspectMattermostSetup,
  type HermesPlatform, type MattermostAdminAuth, type MattermostChannelRole, type MattermostSetupInfo, type MattermostSetupRecord,
} from '@/api/hermes/channels'
import SettingRow from '@/components/hermes/settings/SettingRow.vue'
import { cleanError } from './channel-helpers'

/**
 * "Set up Mattermost for Hermes": after the server URL and bot token are saved and Test passes,
 * Studio creates #hermes, #home-alerts and #server-alerts, adds the bot and the user, and points
 * Hermes's home / free-response / allowed channels and allowed users at them.
 */
const props = defineProps<{ platform: HermesPlatform; testOk: boolean }>()
const emit = defineEmits<{ done: [] }>()
const { t } = useI18n()
const message = useMessage()

const ROLES: MattermostChannelRole[] = ['main', 'home_alerts', 'server_alerts']
const current = ref<MattermostSetupRecord | null>(null)
const info = ref<MattermostSetupInfo | null>(null)
const open = ref(false)
const loading = ref(false)
const running = ref(false)
const error = ref<{ code: string; text: string } | null>(null)
const steps = ref<string[]>([])
const showAdmin = ref(false)
const admin = reactive<Required<MattermostAdminAuth>>({ login_id: '', password: '', token: '' })
const form = reactive({ team_id: '', username: '', channels: { main: 'hermes', home_alerts: 'home-alerts', server_alerts: 'server-alerts' } as Record<MattermostChannelRole, string> })

/** Offered once the token is saved and Hermes has reached the server (Test passed, or it is connected). */
const ready = computed(() => props.platform.configured && (props.testOk || ['connected', 'pending_restart'].includes(props.platform.state) || !!current.value))
const teamOptions = computed(() => (info.value?.teams || []).map(team => ({ label: team.display_name, value: team.id })))
const permissionProblem = computed(() => !!error.value && ['bot_cannot_create_channels', 'bot_cannot_add_members', 'bot_not_in_team', 'user_not_in_team', 'forbidden'].includes(error.value.code))

function adminAuth(): MattermostAdminAuth | undefined {
  if (admin.token.trim()) return { token: admin.token.trim() }
  if (admin.login_id.trim() && admin.password) return { login_id: admin.login_id.trim(), password: admin.password }
  return undefined
}

function forgetAdmin() {
  admin.login_id = ''
  admin.password = ''
  admin.token = ''
}

function setError(err: unknown) {
  const code = (err as { code?: string })?.code || ''
  error.value = { code, text: cleanError(err, t('hermesChannels.mattermost.setup.failed')) }
  if (['bot_cannot_create_channels', 'bot_cannot_add_members', 'bot_not_in_team', 'user_not_in_team', 'forbidden'].includes(code)) showAdmin.value = true
}

async function loadTeams() {
  loading.value = true
  error.value = null
  try {
    info.value = await inspectMattermostSetup(adminAuth())
    const prev = info.value.current || current.value
    const teams = info.value.teams
    if (!teams.some(team => team.id === form.team_id)) {
      form.team_id = (prev && teams.some(team => team.id === prev.team.id) ? prev.team.id : teams.length === 1 ? teams[0].id : '') || ''
    }
    if (prev) {
      if (!form.username) form.username = prev.user.username
      for (const c of prev.channels) form.channels[c.role] = c.name
    }
    if (!teams.length) showAdmin.value = true
  } catch (err) {
    setError(err)
  } finally {
    loading.value = false
  }
}

async function start() {
  open.value = true
  steps.value = []
  await loadTeams()
}

async function run() {
  running.value = true
  error.value = null
  try {
    const result = await applyMattermostSetup({ team_id: form.team_id, username: form.username, channels: { ...form.channels }, admin: adminAuth() })
    current.value = result
    steps.value = result.steps
    forgetAdmin()
    showAdmin.value = false
    open.value = false
    if (result.restart_error) message.warning(`${t('hermesChannels.mattermost.setup.doneNoRestart')} ${result.restart_error}`)
    else message.success(result.restarted ? t('hermesChannels.mattermost.setup.done') : t('hermesChannels.mattermost.setup.doneNoRestart'))
    emit('done')
  } catch (err) {
    setError(err)
  } finally {
    running.value = false
  }
}

onMounted(async () => {
  try { current.value = (await getMattermostSetup()).current } catch { current.value = null }
})
</script>

<template>
  <div class="mm-setup" data-testid="mattermost-setup">
    <div class="head">
      <span class="title">{{ t('hermesChannels.mattermost.setup.title') }}</span>
      <NButton v-if="ready && !open" size="small" :type="current ? 'default' : 'primary'" :loading="loading" data-testid="mattermost-setup-start" @click="start">
        {{ current ? t('hermesChannels.mattermost.setup.redo') : t('hermesChannels.mattermost.setup.start') }}
      </NButton>
    </div>
    <p class="note">{{ ready ? t('hermesChannels.mattermost.setup.intro') : t('hermesChannels.mattermost.setup.needsTest') }}</p>

    <div v-if="current && !open" class="summary">
      <div>{{ t('hermesChannels.mattermost.setup.current', { team: current.team.display_name, user: current.user.username }) }}</div>
      <ul>
        <li v-for="c in current.channels" :key="c.id"><code>~{{ c.name }}</code> · {{ t(`hermesChannels.mattermost.setup.role.${c.role}`) }}</li>
      </ul>
      <div class="note">{{ t('hermesChannels.mattermost.setup.jobsHint') }}</div>
      <ul v-if="steps.length" class="steps">
        <li v-for="(s, i) in steps" :key="i">{{ s }}</li>
      </ul>
    </div>

    <NCollapseTransition :show="open">
      <div class="form">
        <NAlert v-if="info && !info.teams.length" type="warning" :show-icon="false" class="inline-alert">{{ t('hermesChannels.mattermost.setup.noTeams') }}</NAlert>
        <SettingRow :label="t('hermesChannels.mattermost.setup.team')" :hint="info ? t('hermesChannels.mattermost.setup.teamHint', { bot: info.bot.username }) : ''">
          <NSelect v-model:value="form.team_id" :options="teamOptions" :loading="loading" size="small" class="input-md" data-testid="mattermost-setup-team" />
        </SettingRow>
        <SettingRow :label="t('hermesChannels.mattermost.setup.username')" :hint="t('hermesChannels.mattermost.setup.usernameHint')">
          <NInput v-model:value="form.username" size="small" class="input-md" placeholder="your-username" :input-props="{ autocomplete: 'off' }" data-testid="mattermost-setup-username" />
        </SettingRow>
        <SettingRow v-for="role in ROLES" :key="role" :label="t(`hermesChannels.mattermost.setup.role.${role}`)" :hint="t(`hermesChannels.mattermost.setup.roleHint.${role}`)">
          <NInput v-model:value="form.channels[role]" size="small" class="input-md" :placeholder="info?.defaults[role]" :input-props="{ autocomplete: 'off' }" />
        </SettingRow>

        <NAlert v-if="error" :type="permissionProblem ? 'warning' : 'error'" :show-icon="false" class="inline-alert">
          <div>{{ error.text }}</div>
          <div v-if="permissionProblem" class="grant">{{ t('hermesChannels.mattermost.setup.grant') }}</div>
        </NAlert>

        <NButton size="tiny" quaternary class="admin-toggle" @click="showAdmin = !showAdmin">{{ t('hermesChannels.mattermost.setup.admin') }}</NButton>
        <NCollapseTransition :show="showAdmin">
          <p class="note">{{ t('hermesChannels.mattermost.setup.adminHint') }}</p>
          <SettingRow :label="t('hermesChannels.mattermost.setup.adminLogin')">
            <NInput v-model:value="admin.login_id" size="small" class="input-md" :input-props="{ autocomplete: 'off' }" />
          </SettingRow>
          <SettingRow :label="t('hermesChannels.mattermost.setup.adminPassword')">
            <NInput v-model:value="admin.password" type="password" show-password-on="click" size="small" class="input-md" :input-props="{ autocomplete: 'new-password' }" />
          </SettingRow>
          <SettingRow :label="t('hermesChannels.mattermost.setup.adminToken')">
            <NInput v-model:value="admin.token" type="password" show-password-on="click" size="small" class="input-md" :input-props="{ autocomplete: 'off' }" />
          </SettingRow>
          <NButton size="tiny" secondary :loading="loading" :disabled="!adminAuth()" @click="loadTeams">{{ t('hermesChannels.mattermost.setup.reloadTeams') }}</NButton>
        </NCollapseTransition>

        <div class="actions">
          <NButton size="small" quaternary @click="open = false; forgetAdmin()">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" size="small" :loading="running" :disabled="!form.team_id || !form.username.trim()" data-testid="mattermost-setup-run" @click="run">
            {{ t('hermesChannels.mattermost.setup.run') }}
          </NButton>
        </div>
      </div>
    </NCollapseTransition>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.mm-setup {
  margin-top: 10px;
  padding: 8px 12px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: $radius-sm;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.title {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  font-weight: 600;
  color: $text-primary;
}

.note {
  margin: 6px 0 0;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
}

.summary {
  margin-top: 6px;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-secondary;

  ul {
    margin: 4px 0;
    padding-left: 20px;
  }
}

.steps {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
}

.inline-alert {
  margin-top: 8px;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  word-break: break-word;
}

.grant {
  margin-top: 4px;
}

.admin-toggle {
  margin-top: 8px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.input-md {
  min-width: 200px;
}
</style>
