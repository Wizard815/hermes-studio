<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { fetchOrbStatus, fetchOrbWork, saveOrbSettings, type OrbStatus, type OrbWork } from '@/api/studio/orb'

/**
 * Connections → Pondering Orb: Orb's address and token (a Studio setting that
 * Studio agents and Orb's own work requests use), and the Studio chats working
 * on Orb tasks and projects.
 */
const { t } = useI18n()
const toast = useMessage()
const router = useRouter()
const orb = ref<OrbStatus | null>(null)
const url = ref('')
const token = ref('')
const saving = ref(false)
const work = ref<OrbWork[]>([])
let timer = 0

async function load() {
  try {
    orb.value = await fetchOrbStatus()
    url.value = orb.value.settings.url
  } catch { orb.value = null }
  await loadWork()
}

async function loadWork() {
  try { work.value = (await fetchOrbWork()).work } catch { work.value = [] }
}

async function save() {
  saving.value = true
  try {
    await saveOrbSettings({ url: url.value.trim(), ...(token.value.trim() ? { token: token.value.trim() } : {}) })
    token.value = ''
    await load()
    toast.success(orb.value?.connected ? t('orb.connectedToast') : t('orb.saved'))
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    saving.value = false
  }
}

function openChat(item: OrbWork) {
  void router.push({ name: 'hermes.session', params: { sessionId: item.sessionId } })
}

function forWhat(item: OrbWork): string {
  return item.orb.task ? `${item.orb.task.title}${item.orb.task.list ? ` · ${item.orb.task.list}` : ''}` : item.orb.project || ''
}

onMounted(() => {
  void load()
  timer = window.setInterval(() => { void loadWork() }, 10000)
})
onBeforeUnmount(() => { if (timer) window.clearInterval(timer) })
</script>

<template>
  <div class="orb-connection" data-testid="orb-connection">
    <section class="orb-card" data-theme-surface="card">
      <header class="orb-card-head">
        <h3>{{ t('orb.tab') }}</h3>
        <span class="orb-state" :class="{ 'is-good': orb?.connected }" data-testid="orb-state">
          {{ orb?.connected ? t('orb.connected', { version: orb.version }) : t('orb.notConnected') }}
        </span>
      </header>
      <p class="orb-hint">{{ t('orb.optional') }}</p>
      <template v-if="!orb?.settings.fromEnv">
        <div class="orb-form">
          <NInput v-model:value="url" size="small" :placeholder="`${t('orb.address')} (http://pondering-orb:8080)`" data-testid="orb-url" />
          <NInput v-model:value="token" size="small" type="password" :placeholder="orb?.settings.hasToken ? t('orb.tokenKept') : t('orb.token')" data-testid="orb-token" />
          <NButton size="small" type="primary" :loading="saving" data-testid="orb-save" @click="save">{{ t('orb.connect') }}</NButton>
        </div>
        <p v-if="orb?.error && orb.settings.url" class="orb-error">{{ orb.error }}</p>
      </template>
      <p v-else class="orb-hint">{{ t('orb.fromEnv') }}</p>
      <p class="orb-hint">{{ t('orb.hint') }}</p>
    </section>

    <section class="orb-card" data-theme-surface="card">
      <header class="orb-card-head"><h3>{{ t('orb.workTitle') }}</h3></header>
      <p v-if="!work.length" class="orb-hint" data-testid="orb-work-empty">{{ t('orb.workEmpty') }}</p>
      <button
        v-for="item in work"
        :key="item.sessionId"
        type="button"
        class="orb-work"
        data-testid="orb-work"
        @click="openChat(item)"
      >
        <span class="orb-work-status" :data-status="item.status">{{ t(`orb.status.${item.status}`) }}</span>
        <span class="orb-work-title">{{ item.title }}</span>
        <span class="orb-work-meta">{{ forWhat(item) }} · {{ item.agentId }}</span>
      </button>
    </section>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.orb-connection {
  display: flex;
  flex-direction: column;
  gap: calc(16px * var(--spacing-scale, 1));
  max-width: 880px;
  height: 100%;
  overflow: auto;
  padding: calc(20px * var(--spacing-scale, 1));
}

.orb-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  color: $text-primary;
}

.orb-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  h3 {
    margin: 0;
    font-size: 15px;
  }
}

.orb-state {
  font-size: 12px;
  color: $text-muted;

  &.is-good {
    color: $success;
  }
}

.orb-hint,
.orb-error {
  margin: 0;
  font-size: 12.5px;
  color: $text-muted;
}

.orb-error {
  color: $error;
}

.orb-form {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto;
  gap: 8px;
}

.orb-work {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas: 'status title' 'status meta';
  column-gap: 10px;
  align-items: center;
  padding: 8px 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  background: transparent;
  color: $text-primary;
  text-align: left;
  cursor: pointer;

  &:hover {
    border-color: $accent-primary;
  }
}

.orb-work-status {
  grid-area: status;
  min-width: 72px;
  font-size: 11.5px;
  font-weight: 600;
  color: $text-secondary;

  &[data-status='working'] {
    color: $warning;
  }

  &[data-status='blocked'] {
    color: $error;
  }

  &[data-status='done'] {
    color: $success;
  }
}

.orb-work-title {
  grid-area: title;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.orb-work-meta {
  grid-area: meta;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: $text-muted;
}

@media (max-width: $breakpoint-mobile) {
  .orb-form {
    grid-template-columns: 1fr;
  }
}
</style>
