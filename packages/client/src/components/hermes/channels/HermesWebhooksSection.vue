<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, NPopconfirm, NSelect, NSwitch, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  deleteHermesWebhook, enableHermesWebhooks, listHermesWebhooks, saveHermesWebhook, setHermesWebhookEnabled,
  type HermesWebhook,
} from '@/api/hermes/channels'
import { copyToClipboard } from '@/utils/clipboard'
import { cleanError, deliveryTargets, homeAssistantWebhookYaml, normalizeWebhookName, publicWebhookUrl, splitIds } from './channel-helpers'
import { useHermesChannels } from './useHermesChannels'

const { t } = useI18n()
const message = useMessage()
const channels = useHermesChannels()

const enabled = ref(false)
const routes = ref<HermesWebhook[]>([])
const loading = ref(false)
const enabling = ref(false)
const busy = ref('')
const showForm = ref(false)
const editing = ref<HermesWebhook | null>(null)
const saving = ref(false)
const created = ref<{ name: string; url: string; secret: string } | null>(null)
const form = reactive({ name: '', description: '', prompt: '', deliver: 'log', chatId: '', deliverOnly: false, events: '', secret: '' })

const hostname = typeof window !== 'undefined' ? window.location.hostname : ''
const targetOptions = computed(() => deliveryTargets(channels.platforms.value).map(id => ({
  label: id === 'log' ? t('hermesChannels.webhooks.deliverLog') : channels.byId(id)?.name || id,
  value: id,
})))

function url(route: HermesWebhook) {
  return publicWebhookUrl(route.url, hostname)
}

async function load() {
  loading.value = true
  try {
    const res = await listHermesWebhooks()
    enabled.value = res.enabled
    routes.value = res.subscriptions || []
  } catch { /* page-level notice covers an unreachable Hermes */ } finally {
    loading.value = false
  }
}

async function enable() {
  enabling.value = true
  try {
    const res = await enableHermesWebhooks()
    if (res.needs_restart) channels.markRestartNeeded()
    message.success(t('hermesChannels.webhooks.enabledMsg'))
    await load()
  } catch (err) {
    message.error(cleanError(err, t('hermesChannels.saveFailed')))
  } finally {
    enabling.value = false
  }
}

function openForm(route?: HermesWebhook) {
  editing.value = route || null
  Object.assign(form, {
    name: route?.name || '',
    description: route?.description || '',
    prompt: route?.prompt || '',
    deliver: route?.deliver || 'log',
    chatId: '',
    deliverOnly: route?.deliver_only || false,
    events: (route?.events || []).join(', '),
    secret: '',
  })
  showForm.value = true
}

async function submit() {
  const name = editing.value?.name || normalizeWebhookName(form.name)
  if (!name) {
    message.warning(t('hermesChannels.webhooks.badName'))
    return
  }
  if (form.deliverOnly && form.deliver === 'log') {
    message.warning(t('hermesChannels.webhooks.deliverOnlyNeedsTarget'))
    return
  }
  saving.value = true
  try {
    const res = await saveHermesWebhook({
      name,
      description: form.description.trim() || undefined,
      prompt: form.prompt,
      deliver: form.deliver || 'log',
      deliver_only: form.deliverOnly,
      deliver_chat_id: form.chatId.trim() || undefined,
      events: splitIds(form.events),
      skills: editing.value?.skills || [],
      secret: form.secret.trim() || undefined,
    })
    showForm.value = false
    if (res.secret) created.value = { name, url: url(res), secret: res.secret }
    await load()
  } catch (err) {
    message.error(cleanError(err, t('hermesChannels.saveFailed')))
  } finally {
    saving.value = false
  }
}

async function toggle(route: HermesWebhook, value: boolean) {
  busy.value = route.name
  try {
    await setHermesWebhookEnabled(route.name, value)
    route.enabled = value
  } catch (err) {
    message.error(cleanError(err, t('hermesChannels.saveFailed')))
  } finally {
    busy.value = ''
  }
}

async function remove(route: HermesWebhook) {
  busy.value = route.name
  try {
    await deleteHermesWebhook(route.name)
    message.success(t('hermesChannels.webhooks.deleted'))
    await load()
  } catch (err) {
    message.error(cleanError(err, t('hermesChannels.saveFailed')))
  } finally {
    busy.value = ''
  }
}

async function copy(text: string) {
  if (await copyToClipboard(text)) message.success(t('hermesChannels.copied'))
}

onMounted(load)
</script>

<template>
  <section class="hermes-section">
    <div class="section-head">
      <div>
        <h3 class="section-title">{{ t('hermesChannels.webhooks.title') }}</h3>
        <p class="section-hint">{{ t('hermesChannels.webhooks.hint') }}</p>
      </div>
      <NButton v-if="enabled" size="small" type="primary" @click="openForm()">{{ t('hermesChannels.webhooks.add') }}</NButton>
    </div>

    <div class="card">
      <div v-if="!enabled && !loading" class="row">
        <span class="row-main">{{ t('hermesChannels.webhooks.off') }}</span>
        <NButton size="small" type="primary" :loading="enabling" @click="enable">{{ t('hermesChannels.webhooks.turnOn') }}</NButton>
      </div>
      <template v-else>
        <div v-for="route in routes" :key="route.name" class="route">
          <div class="row">
            <div class="row-main">
              <strong>{{ route.name }}</strong>
              <NTag size="small" :bordered="false">{{ t('hermesChannels.webhooks.to') }} {{ route.deliver === 'log' ? t('hermesChannels.webhooks.deliverLog') : channels.byId(route.deliver)?.name || route.deliver }}</NTag>
              <NTag v-if="route.secret_set" size="small" type="success" :bordered="false">{{ t('hermesChannels.webhooks.signed') }}</NTag>
            </div>
            <div class="row-actions">
              <NSwitch size="small" :value="route.enabled" :loading="busy === route.name" @update:value="v => toggle(route, v)" />
              <NButton size="tiny" quaternary @click="openForm(route)">{{ t('hermesChannels.edit') }}</NButton>
              <NPopconfirm @positive-click="remove(route)">
                <template #trigger><NButton size="tiny" quaternary type="error">{{ t('hermesChannels.remove') }}</NButton></template>
                {{ t('hermesChannels.webhooks.deleteConfirm', { name: route.name }) }}
              </NPopconfirm>
            </div>
          </div>
          <div class="route-url">
            <code>{{ url(route) }}</code>
            <NButton size="tiny" quaternary @click="copy(url(route))">{{ t('hermesChannels.copy') }}</NButton>
            <NButton size="tiny" quaternary :title="t('hermesExtensions.home.webhook.copyHaHint')" @click="copy(homeAssistantWebhookYaml(route.name, url(route)))">{{ t('hermesExtensions.home.webhook.copyHa') }}</NButton>
          </div>
          <p v-if="route.description" class="muted">{{ route.description }}</p>
        </div>
        <p v-if="!routes.length" class="muted">{{ t('hermesChannels.webhooks.none') }}</p>
      </template>
    </div>

    <NModal v-model:show="showForm" preset="card" :title="editing ? t('hermesChannels.webhooks.editTitle', { name: editing.name }) : t('hermesChannels.webhooks.add')" style="max-width: 560px">
      <NForm label-placement="top" size="small">
        <NFormItem v-if="!editing" :label="t('hermesChannels.webhooks.name')">
          <NInput v-model:value="form.name" placeholder="github-push" />
        </NFormItem>
        <NFormItem :label="t('hermesChannels.webhooks.description')">
          <NInput v-model:value="form.description" />
        </NFormItem>
        <NFormItem :label="t('hermesChannels.webhooks.prompt')">
          <NInput v-model:value="form.prompt" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" :placeholder="t('hermesChannels.webhooks.promptHint')" />
        </NFormItem>
        <NFormItem :label="t('hermesChannels.webhooks.deliver')">
          <NSelect v-model:value="form.deliver" :options="targetOptions" filterable tag />
        </NFormItem>
        <NFormItem v-if="form.deliver !== 'log'" :label="t('hermesChannels.webhooks.chatId')">
          <NInput v-model:value="form.chatId" :placeholder="t('hermesChannels.webhooks.chatIdHint')" />
        </NFormItem>
        <NFormItem v-if="form.deliver !== 'log'" :label="t('hermesChannels.webhooks.deliverOnly')">
          <NSwitch v-model:value="form.deliverOnly" />
        </NFormItem>
        <NFormItem :label="t('hermesChannels.webhooks.events')">
          <NInput v-model:value="form.events" :placeholder="t('hermesChannels.webhooks.eventsHint')" />
        </NFormItem>
        <NFormItem :label="t('hermesChannels.webhooks.secret')">
          <NInput v-model:value="form.secret" type="password" show-password-on="click" :input-props="{ autocomplete: 'off' }" :placeholder="editing ? t('hermesChannels.webhooks.secretEditHint') : t('hermesChannels.webhooks.secretHint')" />
        </NFormItem>
      </NForm>
      <template #footer>
        <div class="modal-actions">
          <NButton size="small" quaternary @click="showForm = false">{{ t('hermesChannels.cancel') }}</NButton>
          <NButton size="small" type="primary" :loading="saving" @click="submit">{{ t('hermesChannels.save') }}</NButton>
        </div>
      </template>
    </NModal>

    <NModal :show="!!created" preset="card" :title="t('hermesChannels.webhooks.createdTitle')" style="max-width: 560px" @update:show="v => { if (!v) created = null }">
      <template v-if="created">
        <NAlert type="warning" :show-icon="false">{{ t('hermesChannels.webhooks.secretOnce') }}</NAlert>
        <div class="created-row"><span class="muted">{{ t('hermesChannels.webhooks.url') }}</span><code>{{ created.url }}</code><NButton size="tiny" quaternary @click="copy(created.url)">{{ t('hermesChannels.copy') }}</NButton></div>
        <div class="created-row"><span class="muted">{{ t('hermesChannels.webhooks.secret') }}</span><code>{{ created.secret }}</code><NButton size="tiny" quaternary @click="copy(created.secret)">{{ t('hermesChannels.copy') }}</NButton></div>
        <div class="created-row"><span class="muted">{{ t('hermesExtensions.home.webhook.copyHaHint') }}</span><NButton size="tiny" secondary @click="copy(homeAssistantWebhookYaml(created.name, created.url, created.secret))">{{ t('hermesExtensions.home.webhook.copyHa') }}</NButton></div>
      </template>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
@use './section' as *;

.route {
  border-bottom: var(--border-width, 1px) solid $border-light;
  padding-bottom: 6px;

  &:last-of-type {
    border-bottom: none;
  }

  .row {
    border-bottom: none;
    padding-bottom: 2px;
  }
}

.row-actions,
.route-url,
.created-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.route-url code,
.created-row code {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-secondary;
  word-break: break-all;
}

.created-row {
  margin-top: 10px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
