<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import QRCode from 'qrcode'
import { NAlert, NButton, NInput, NRadioButton, NRadioGroup, NSpin, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  applyTelegramOnboarding, applyWhatsAppOnboarding, cancelTelegramOnboarding, cancelWhatsAppOnboarding,
  getTelegramOnboarding, getWhatsAppOnboarding, startTelegramOnboarding, startWhatsAppOnboarding,
  type HermesPlatform, type RestartResult,
} from '@/api/hermes/channels'
import { cleanError, splitIds } from './channel-helpers'
import { useHermesChannels } from './useHermesChannels'

const props = defineProps<{ platform: HermesPlatform }>()
const emit = defineEmits<{ done: [] }>()

const { t } = useI18n()
const message = useMessage()
const channels = useHermesChannels()

type Step = 'idle' | 'form' | 'starting' | 'waiting' | 'ready' | 'applying' | 'error'
const step = ref<Step>('idle')
const pairingId = ref('')
const qrDataUrl = ref('')
const link = ref('')
const error = ref('')
const detail = ref('')
// Telegram
const botName = ref('')
const allowedIds = ref('')
// WhatsApp
const waMode = ref<'bot' | 'self-chat'>('bot')
const waAllowed = ref('')
const waReset = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

const isTelegram = computed(() => props.platform.id === 'telegram')
const title = computed(() => isTelegram.value ? t('hermesChannels.onboarding.telegramTitle') : t('hermesChannels.onboarding.whatsappTitle'))

async function showQr(payload: string) {
  try {
    qrDataUrl.value = await QRCode.toDataURL(payload, { margin: 1, width: 220 })
  } catch {
    qrDataUrl.value = ''
  }
}

function stopPoll() {
  if (timer) clearTimeout(timer)
  timer = null
}
onUnmounted(() => {
  stopPoll()
  // Leave nothing half-started on Hermes's side when the page closes mid-setup.
  if (pairingId.value && step.value !== 'idle') void cancelRemote()
})

function fail(err: unknown) {
  stopPoll()
  error.value = cleanError(err, t('hermesChannels.onboarding.failed'))
  step.value = 'error'
}

async function start() {
  error.value = ''
  detail.value = ''
  qrDataUrl.value = ''
  step.value = 'starting'
  try {
    if (isTelegram.value) {
      const res = await startTelegramOnboarding(botName.value.trim())
      pairingId.value = res.pairing_id
      link.value = res.deep_link
      detail.value = res.suggested_username ? `@${res.suggested_username}` : ''
      await showQr(res.qr_payload || res.deep_link)
      step.value = 'waiting'
    } else {
      const res = await startWhatsAppOnboarding({ mode: waMode.value, allowed_users: waAllowed.value.trim(), reset_session: waReset.value })
      pairingId.value = res.pairing_id
      await applyWhatsAppState(res)
    }
    if (step.value === 'waiting') poll()
  } catch (err) {
    fail(err)
  }
}

async function applyWhatsAppState(res: Awaited<ReturnType<typeof getWhatsAppOnboarding>>) {
  if (res.status === 'connected') {
    detail.value = [res.account_name, res.account_phone || res.account_id].filter(Boolean).join(' · ')
    qrDataUrl.value = ''
    step.value = 'ready'
  } else if (res.status === 'error' || res.status === 'expired' || res.status === 'cancelled') {
    fail(res.error || t('hermesChannels.onboarding.expired'))
  } else {
    if (res.qr_payload) await showQr(res.qr_payload)
    step.value = 'waiting'
  }
}

function poll() {
  stopPoll()
  timer = setTimeout(async () => {
    if (step.value !== 'waiting') return
    try {
      if (isTelegram.value) {
        const res = await getTelegramOnboarding(pairingId.value)
        if (res.status === 'ready') {
          detail.value = res.bot_username ? `@${res.bot_username}` : detail.value
          if (res.owner_user_id && !allowedIds.value) allowedIds.value = res.owner_user_id
          step.value = 'ready'
          return
        }
      } else {
        await applyWhatsAppState(await getWhatsAppOnboarding(pairingId.value))
        if (step.value !== 'waiting') return
      }
      poll()
    } catch (err) {
      fail(err)
    }
  }, 2500)
}

async function finish() {
  step.value = 'applying'
  try {
    let res: RestartResult
    if (isTelegram.value) {
      const ids = splitIds(allowedIds.value)
      if (!ids.length) {
        message.warning(t('hermesChannels.onboarding.needUserId'))
        step.value = 'ready'
        return
      }
      res = await applyTelegramOnboarding(pairingId.value, ids)
    } else {
      res = await applyWhatsAppOnboarding(pairingId.value, { mode: waMode.value, allowed_users: waAllowed.value.trim() || undefined })
    }
    pairingId.value = ''
    step.value = 'idle'
    message.success(t('hermesChannels.onboarding.done'))
    emit('done')
    if (res.needs_restart) channels.markRestartNeeded()
  } catch (err) {
    message.error(cleanError(err, t('hermesChannels.onboarding.failed')))
    step.value = 'ready'
  }
}

async function cancelRemote() {
  const id = pairingId.value
  pairingId.value = ''
  if (!id) return
  try {
    if (isTelegram.value) await cancelTelegramOnboarding(id)
    else await cancelWhatsAppOnboarding(id)
  } catch { /* already gone */ }
}

async function cancel() {
  stopPoll()
  await cancelRemote()
  step.value = 'idle'
  error.value = ''
}
</script>

<template>
  <div class="onboarding">
    <div v-if="step === 'idle'" class="onboarding-intro">
      <span>{{ isTelegram ? t('hermesChannels.onboarding.telegramIntro') : t('hermesChannels.onboarding.whatsappIntro') }}</span>
      <NButton size="small" type="primary" secondary @click="step = 'form'">{{ title }}</NButton>
    </div>

    <div v-else class="onboarding-box">
      <div class="onboarding-title">{{ title }}</div>

      <template v-if="step === 'form'">
        <template v-if="isTelegram">
          <p class="hint">{{ t('hermesChannels.onboarding.telegramHow') }}</p>
          <NInput v-model:value="botName" size="small" :placeholder="t('hermesChannels.onboarding.botName')" class="field" />
        </template>
        <template v-else>
          <p class="hint">{{ t('hermesChannels.onboarding.whatsappHow') }}</p>
          <NRadioGroup v-model:value="waMode" size="small" class="field">
            <NRadioButton value="bot">{{ t('hermesChannels.onboarding.modeBot') }}</NRadioButton>
            <NRadioButton value="self-chat">{{ t('hermesChannels.onboarding.modeSelf') }}</NRadioButton>
          </NRadioGroup>
          <NInput v-model:value="waAllowed" size="small" :placeholder="t('hermesChannels.onboarding.allowedNumbers')" class="field" />
          <label class="reset"><NSwitch v-model:value="waReset" size="small" /> {{ t('hermesChannels.onboarding.relink') }}</label>
        </template>
        <div class="buttons">
          <NButton size="small" quaternary @click="step = 'idle'">{{ t('hermesChannels.cancel') }}</NButton>
          <NButton size="small" type="primary" @click="start">{{ t('hermesChannels.onboarding.start') }}</NButton>
        </div>
      </template>

      <div v-else-if="step === 'starting'" class="center"><NSpin size="small" /> {{ t('hermesChannels.onboarding.starting') }}</div>

      <template v-else-if="step === 'waiting'">
        <p class="hint">{{ isTelegram ? t('hermesChannels.onboarding.telegramScan') : t('hermesChannels.onboarding.whatsappScan') }}</p>
        <div class="qr">
          <img v-if="qrDataUrl" :src="qrDataUrl" alt="QR" />
          <div v-else class="center"><NSpin size="small" /> <span v-if="!isTelegram">{{ t('hermesChannels.onboarding.preparing') }}</span></div>
        </div>
        <p v-if="link" class="hint"><a :href="link" target="_blank" rel="noopener">{{ t('hermesChannels.onboarding.openLink') }}</a> <span v-if="detail">{{ detail }}</span></p>
        <div class="buttons"><NButton size="small" quaternary @click="cancel">{{ t('hermesChannels.cancel') }}</NButton></div>
      </template>

      <template v-else-if="step === 'ready' || step === 'applying'">
        <NAlert type="success" :show-icon="false">{{ t('hermesChannels.onboarding.linked') }} <strong v-if="detail">{{ detail }}</strong></NAlert>
        <template v-if="isTelegram">
          <p class="hint">{{ t('hermesChannels.onboarding.telegramUsers') }}</p>
          <NInput v-model:value="allowedIds" size="small" placeholder="123456789" class="field" />
        </template>
        <div class="buttons">
          <NButton size="small" quaternary :disabled="step === 'applying'" @click="cancel">{{ t('hermesChannels.cancel') }}</NButton>
          <NButton size="small" type="primary" :loading="step === 'applying'" @click="finish">{{ t('hermesChannels.onboarding.finish') }}</NButton>
        </div>
      </template>

      <template v-else-if="step === 'error'">
        <NAlert type="error" :show-icon="false">{{ error }}</NAlert>
        <div class="buttons">
          <NButton size="small" quaternary @click="cancel">{{ t('hermesChannels.cancel') }}</NButton>
          <NButton size="small" @click="step = 'form'">{{ t('hermesChannels.onboarding.retry') }}</NButton>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.onboarding {
  margin-top: 10px;
}

.onboarding-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-secondary;
}

.onboarding-box {
  padding: 12px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: $radius-md;
}

.onboarding-title {
  font-weight: 500;
  color: $text-primary;
  margin-bottom: 6px;
}

.hint {
  margin: 6px 0;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-secondary;
}

.field {
  margin: 6px 0;
  max-width: 360px;
}

.reset {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-secondary;
}

.qr {
  display: flex;
  justify-content: center;
  padding: 8px 0;

  img {
    width: 220px;
    height: 220px;
    border-radius: $radius-md;
    /* theme-exception: qr -- Opaque quiet zone is required for reliable scanning. */
    background: #fff;
  }
}

.center {
  display: flex;
  align-items: center;
  gap: 8px;
  color: $text-muted;
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
