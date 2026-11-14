<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NInput, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { addSavedLogin, listSavedLogins, removeSavedLogin, type SavedLogin, getBrowserActivity, getScreenStatus, installScreen, screenControl, screenSocketUrl, startScreen, stopScreen, type BrowserActivity, type ScreenStatus } from '@/api/studio/screen'

/**
 * The agents' screen (Hermes Bot Screen): a desktop with a real browser that
 * agents use. You watch it live; Take over gives you the keyboard and mouse
 * (the agent's screen and browser tools wait), Hand back returns them.
 */
const props = defineProps<{ active: boolean }>()
const { t } = useI18n()

const status = ref<ScreenStatus | null>(null)
const busy = ref('')
const failure = ref('')
const connected = ref(false)
const viewer = ref<HTMLDivElement | null>(null)
let rfb: any = null
let poll: ReturnType<typeof setTimeout> | null = null
let reconnect: ReturnType<typeof setTimeout> | null = null
let disposed = false
const showActivity = ref(false)
const showLogins = ref(false)
const logins = ref<SavedLogin[]>([])
const loginForm = ref({ label: '', origin: '', identifierType: 'email' as 'email' | 'username' | 'phone', identifier: '', password: '', otpSecret: '' })
const savingLogin = ref(false)
const toast = useMessage()
const identifierTypes = computed(() => (['email', 'username', 'phone'] as const).map(value => ({ value, label: t(`screen.identifier.${value}`) })))

async function loadLogins() {
  try { logins.value = (await listSavedLogins()).items } catch (error) { failure.value = errorText(error) }
}

function toggleLogins() {
  showLogins.value = !showLogins.value
  if (showLogins.value) { showActivity.value = false; void loadLogins() }
}

async function saveLogin() {
  savingLogin.value = true
  try {
    const form = loginForm.value
    await addSavedLogin({ ...form, origin: form.origin.trim(), otpSecret: form.otpSecret.trim() || undefined })
    loginForm.value = { label: '', origin: '', identifierType: form.identifierType, identifier: '', password: '', otpSecret: '' }
    toast.success(t('screen.loginSaved'))
    await loadLogins()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    savingLogin.value = false
  }
}

async function removeLogin(item: SavedLogin) {
  try { await removeSavedLogin(item.id); await loadLogins() } catch (error) { toast.error(errorText(error)) }
}
const activity = ref<BrowserActivity[]>([])

async function loadActivity() {
  try { activity.value = (await getBrowserActivity(100)).activity.slice().reverse() } catch { /* keep the last list */ }
}

function toggleActivity() {
  showActivity.value = !showActivity.value
  if (showActivity.value) showLogins.value = false
  if (showActivity.value) void loadActivity()
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function hostOf(url?: string): string {
  if (!url) return ''
  try { return new URL(url).host } catch { return '' }
}

const running = computed(() => !!status.value?.running)
const lease = computed(() => status.value?.lease)
const youHaveControl = computed(() => !!status.value?.youHaveControl)
const someoneElse = computed(() => lease.value?.holder === 'human' && !youHaveControl.value)
const controlText = computed(() => youHaveControl.value ? t('screen.youControl') : someoneElse.value ? t('screen.someoneControls') : t('screen.agentControls'))

function errorText(error: unknown): string {
  return (error as any)?.data?.error || (error as any)?.message || String(error)
}

async function refresh() {
  if (poll) { clearTimeout(poll); poll = null }
  try {
    status.value = await getScreenStatus()
    failure.value = ''
  } catch (error) {
    failure.value = errorText(error)
  }
  if (rfb) rfb.viewOnly = !youHaveControl.value
  if (running.value && props.active && !rfb) void connect()
  if (!running.value && rfb) disconnect()
  if (showActivity.value) void loadActivity()
  if (!disposed && props.active) poll = setTimeout(() => void refresh(), status.value?.installing || status.value?.starting ? 2000 : 4000)
}

async function connect() {
  if (rfb || !viewer.value || disposed) return
  try {
    const { default: RFB } = await import('@novnc/novnc')
    const url = await screenSocketUrl()
    if (rfb || disposed || !viewer.value) return
    const client = new RFB(viewer.value, url, { shared: true })
    client.scaleViewport = true
    client.resizeSession = false
    client.focusOnClick = true
    client.background = 'transparent'
    client.viewOnly = !youHaveControl.value
    client.addEventListener('connect', () => { connected.value = true })
    client.addEventListener('disconnect', () => {
      connected.value = false
      if (rfb === client) rfb = null
      // Control taken by someone else, a restart, a dropped link: look again and reconnect.
      if (!disposed && props.active) reconnect = setTimeout(() => void refresh(), 1500)
    })
    rfb = client
  } catch (error) {
    failure.value = errorText(error)
  }
}

function disconnect() {
  if (reconnect) { clearTimeout(reconnect); reconnect = null }
  const client = rfb
  rfb = null
  connected.value = false
  try { client?.disconnect() } catch { /* already closed */ }
}

async function act(name: string, work: () => Promise<unknown>) {
  busy.value = name
  failure.value = ''
  try { await work() } catch (error) { failure.value = errorText(error) } finally { busy.value = '' }
  await refresh()
}

const install = () => act('install', installScreen)
const start = () => act('start', startScreen)
const stop = () => act('stop', () => stopScreen(false))
const takeOver = () => act('take', async () => { await screenControl('take'); await nextTick(); rfb?.focus() })
const handBack = () => act('release', () => screenControl('release'))
const forceBack = () => act('force', () => screenControl('force'))

watch(() => props.active, (active) => {
  if (active) void refresh()
  else { if (poll) clearTimeout(poll); poll = null }
}, { immediate: true })

onBeforeUnmount(() => {
  disposed = true
  if (poll) clearTimeout(poll)
  disconnect()
})
</script>

<template>
  <div class="screen-center" :class="{ 'is-yours': youHaveControl }" data-testid="screen-center">
    <div class="screen-bar">
      <span class="screen-title">{{ t('screen.title') }}</span>
      <template v-if="running">
        <span class="screen-chip" :data-holder="youHaveControl ? 'you' : someoneElse ? 'other' : 'agent'" data-testid="screen-control">{{ controlText }}</span>
        <span v-if="lease?.reason" class="screen-reason" :title="lease.reason">{{ lease.reason }}</span>
      </template>
      <span class="screen-spacer" />
      <NButton size="tiny" quaternary :type="showActivity ? 'primary' : 'default'" data-testid="screen-activity-toggle" @click="toggleActivity">{{ t('screen.activity') }}</NButton>
      <NButton size="tiny" quaternary :type="showLogins ? 'primary' : 'default'" data-testid="screen-logins-toggle" @click="toggleLogins">{{ t('screen.logins') }}</NButton>
      <template v-if="running">
        <NButton v-if="!youHaveControl" size="tiny" type="error" :loading="busy === 'take'" data-testid="screen-take" @click="takeOver">{{ t('screen.takeOver') }}</NButton>
        <NButton v-else size="tiny" type="primary" :loading="busy === 'release'" data-testid="screen-handback" @click="handBack">{{ t('screen.handBack') }}</NButton>
        <NButton v-if="someoneElse" size="tiny" quaternary :loading="busy === 'force'" @click="forceBack">{{ t('screen.forceBack') }}</NButton>
        <NButton size="tiny" quaternary :loading="busy === 'stop'" :disabled="lease?.holder === 'human'" data-testid="screen-stop" @click="stop">{{ t('screen.stop') }}</NButton>
      </template>
    </div>
    <div class="screen-body">
      <div v-show="running" ref="viewer" class="screen-viewer" data-testid="screen-viewer" />
      <aside v-if="showActivity" class="screen-activity" data-testid="screen-activity">
        <p v-if="!activity.length" class="screen-hint">{{ t('screen.activityEmpty') }}</p>
        <div v-for="(item, index) in activity" :key="`${item.at}-${index}`" class="activity-item" :data-outcome="item.outcome">
          <div class="activity-line">
            <span class="activity-time">{{ timeOf(item.at) }}</span>
            <span class="activity-outcome">{{ t(`screen.outcome.${item.outcome}`) }}</span>
            <span v-if="item.agentId" class="activity-agent">{{ item.agentId }}</span>
          </div>
          <div class="activity-summary">{{ item.summary }}</div>
          <div v-if="hostOf(item.url)" class="activity-url" :title="item.url">{{ hostOf(item.url) }}</div>
          <div v-if="item.error" class="activity-error">{{ item.error }}</div>
        </div>
      </aside>
      <aside v-if="showLogins" class="screen-activity" data-testid="screen-logins">
        <p class="screen-hint">{{ t('screen.loginsHint') }}</p>
        <div v-for="item in logins" :key="item.id" class="activity-item login-item">
          <div class="activity-summary"><strong>{{ item.label }}</strong></div>
          <div class="activity-url">{{ item.origin }}</div>
          <div class="activity-line">{{ item.identifier }}<span v-if="item.has_otp"> · 2FA</span></div>
          <button type="button" class="login-remove" @click="removeLogin(item)">{{ t('screen.remove') }}</button>
        </div>
        <p v-if="!logins.length" class="screen-hint">{{ t('screen.loginsEmpty') }}</p>
        <form class="login-form" autocomplete="off" @submit.prevent="saveLogin">
          <NInput v-model:value="loginForm.origin" size="small" :placeholder="t('screen.site')" data-testid="login-origin" />
          <NInput v-model:value="loginForm.label" size="small" :placeholder="t('screen.loginLabel')" data-testid="login-label" />
          <NSelect v-model:value="loginForm.identifierType" size="small" :options="identifierTypes" />
          <NInput v-model:value="loginForm.identifier" size="small" :placeholder="t(`screen.identifier.${loginForm.identifierType}`)" data-testid="login-identifier" />
          <NInput v-model:value="loginForm.password" size="small" type="password" show-password-on="click" :input-props="{ autocomplete: 'new-password' }" :placeholder="t('screen.password')" data-testid="login-password" />
          <NInput v-model:value="loginForm.otpSecret" size="small" type="password" :input-props="{ autocomplete: 'off' }" :placeholder="t('screen.otpSecret')" />
          <NButton size="small" type="primary" attr-type="submit" :loading="savingLogin" :disabled="!loginForm.origin || !loginForm.label || !loginForm.identifier || !loginForm.password" data-testid="login-save">{{ t('screen.saveLogin') }}</NButton>
        </form>
      </aside>
    </div>
    <div v-if="!running" class="screen-state">
      <template v-if="status && !status.available">
        <p class="screen-headline">{{ t('screen.unavailable') }}</p>
        <p class="screen-hint">{{ status.error || t('screen.unavailableHint') }}</p>
      </template>
      <template v-else-if="status?.installing">
        <p class="screen-headline">{{ t('screen.installing') }}</p>
        <pre v-if="status.log.length" class="screen-log">{{ status.log.slice(-8).join('\n') }}</pre>
      </template>
      <template v-else-if="status && !status.installed">
        <p class="screen-headline">{{ t('screen.notInstalled') }}</p>
        <p class="screen-hint">{{ t('screen.installHint') }}</p>
        <NButton type="primary" :disabled="!status.supported" :loading="busy === 'install'" data-testid="screen-install" @click="install">{{ t('screen.install') }}</NButton>
        <pre v-if="status.error && status.log.length" class="screen-log">{{ status.log.slice(-8).join('\n') }}</pre>
      </template>
      <template v-else-if="status">
        <p class="screen-headline">{{ t('screen.off') }}</p>
        <p class="screen-hint">{{ status.blocker || t('screen.offHint') }}</p>
        <NButton type="primary" :disabled="!!status.blocker" :loading="busy === 'start' || status.starting" data-testid="screen-start" @click="start">{{ t('screen.start') }}</NButton>
      </template>
      <p v-else class="screen-hint">{{ t('screen.loading') }}</p>
    </div>
    <p v-if="failure || (running && status?.error)" class="screen-error" data-testid="screen-error">{{ failure || status?.error }}</p>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.screen-center {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  border-right: var(--border-width, 1px) solid $border-light;
  outline: 2px solid transparent;
  outline-offset: -2px;

  &.is-yours { outline-color: $error; }
}

.screen-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  min-height: 32px;
  font-size: 12px;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.screen-title { font-weight: 600; }
.screen-spacer { flex: 1; }

.screen-chip {
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11.5px;
  background: rgba(127, 127, 127, 0.15);

  &[data-holder='you'] { background: $error; color: #fff; }
  &[data-holder='other'] { background: $warning; color: #000; }
}

.screen-reason {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
  max-width: 40%;
}

.screen-body {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}

.screen-activity {
  width: 280px;
  flex-shrink: 0;
  overflow: auto;
  padding: 8px;
  font-size: 12px;
  border-left: var(--border-width, 1px) solid $border-light;
}

.activity-item {
  padding: 6px 4px;
  border-bottom: var(--border-width, 1px) solid $border-light;

  &[data-outcome='failed'] .activity-outcome,
  &[data-outcome='refused'] .activity-outcome,
  &[data-outcome='stopped'] .activity-outcome { color: $error; }
  &[data-outcome='allowed'] .activity-outcome { color: $warning; }
}

.activity-line { display: flex; gap: 6px; opacity: 0.75; font-size: 11px; }
.activity-outcome { font-weight: 600; }
.activity-summary { margin-top: 2px; word-break: break-word; }
.activity-url { opacity: 0.6; font-size: 11px; }
.activity-error { color: $error; font-size: 11px; word-break: break-word; }

.login-item { position: relative; }

.login-remove {
  position: absolute;
  top: 6px;
  right: 4px;
  border: 0;
  background: none;
  color: $error;
  cursor: pointer;
  font-size: 11px;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}

.screen-viewer {
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: #111;
  overflow: hidden;
}

.screen-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
}

.screen-headline { margin: 0; font-size: 15px; font-weight: 600; }
.screen-hint { margin: 0; max-width: 480px; opacity: 0.75; }

.screen-log {
  margin: 0;
  max-width: min(640px, 100%);
  max-height: 160px;
  overflow: auto;
  font-size: 11px;
  text-align: left;
  white-space: pre-wrap;
  opacity: 0.7;
}

.screen-error {
  margin: 0;
  padding: 4px 10px;
  font-size: 12px;
  color: $error;
}
</style>
