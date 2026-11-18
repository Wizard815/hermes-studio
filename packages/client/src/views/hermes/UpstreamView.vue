<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import PageHeader from '@/components/layout/PageHeader.vue'
import { getApiKey, request } from '@/api/client'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

// Upstream Manager, served by Studio's own /upstream proxy so it lives on the same origin/port as
// Studio (#/hermes/upstream) instead of a separate localhost:5001. It renders in a full-frame iframe.
//
// The two stay in step: `?path=/work?task=…` opens that Upstream page (Studio links to an Upstream
// task this way, e.g. from a chat whose herdr agent works on one), Upstream reports which page it shows
// so Studio's address, back button and reloads keep the place, and a link in Upstream to a Studio chat
// opens that chat in Studio itself.
const UPSTREAM_PATH = (import.meta.env.VITE_UPSTREAM_PATH || '/upstream').replace(/\/+$/, '')

/** A page inside Upstream ("/work?task=x"); anything else is the start page. */
function safePath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\s]/.test(raw) || raw.includes('://')) return '/'
  return raw
}

function frameUrl(path: string): string {
  const [pathname, search = ''] = path.split('?', 2)
  const params = new URLSearchParams(search)
  // The proxy requires a Studio login; the token is exchanged for a scoped cookie on first load.
  params.set('token', getApiKey())
  return `${UPSTREAM_PATH}${pathname === '/' ? '/' : pathname}?${params.toString()}`
}

const shown = ref(safePath(route.query.path))
const frameSrc = ref(frameUrl(shown.value))
const frame = ref<HTMLIFrameElement | null>(null)
const loaded = ref(false)
const frameError = ref(false)

interface UpstreamStatus { target: string; reachable: boolean; error?: string; openTasks?: number }
const status = ref<UpstreamStatus | null>(null)
const unreachable = computed(() => status.value && !status.value.reachable)

async function checkStatus() {
  try {
    status.value = await request<UpstreamStatus>('/api/studio/upstream/status')
  } catch {
    status.value = null   // can't tell (older server): just show the frame
  }
}

// Studio asks for a page (a link here while the tab is open): tell Upstream instead of reloading it.
watch(() => route.query.path, (value) => {
  const path = safePath(value)
  if (path === shown.value) return
  shown.value = path
  const win = frame.value?.contentWindow
  if (win && loaded.value) win.postMessage({ type: 'upstream:open', path }, window.location.origin)
  else frameSrc.value = frameUrl(path)
})

// Upstream says which page it shows: keep it in Studio's address (no new history entry each time).
function onMessage(event: MessageEvent) {
  if (event.origin !== window.location.origin || event.source !== frame.value?.contentWindow) return
  const data = event.data as { type?: unknown; path?: unknown } | null
  if (data?.type !== 'upstream:route') return
  const path = safePath(data.path)
  if (path === shown.value) return
  shown.value = path
  void router.replace({ query: { ...route.query, path: path === '/' ? undefined : path } })
}

onMounted(() => {
  window.addEventListener('message', onMessage)
  void checkStatus()
})
onUnmounted(() => window.removeEventListener('message', onMessage))

function retry() {
  frameError.value = false
  loaded.value = false
  frameSrc.value = `${frameUrl(shown.value)}&_=${Date.now()}`
  void checkStatus()
}
</script>

<template>
  <div class="upstream-view">
    <PageHeader>
      <header class="page-header">
        <h2 class="header-title">{{ t('sidebar.upstream') }}</h2>
        <span v-if="status?.reachable && status.openTasks" class="upstream-count" :title="t('upstreamView.openTasks', { count: status.openTasks })">{{ status.openTasks }}</span>
      </header>
    </PageHeader>

    <div class="upstream-frame-wrap">
      <iframe
        v-if="!unreachable"
        ref="frame"
        :src="frameSrc"
        class="upstream-frame"
        title="Upstream Manager"
        @load="loaded = true"
        @error="frameError = true"
      />
      <div v-if="unreachable || frameError" class="upstream-frame-fallback" data-testid="upstream-unreachable">
        <div>
          <p>{{ t('upstreamView.unreachable', { target: status?.target || 'http://127.0.0.1:5001' }) }}</p>
          <p v-if="status?.error" class="muted">{{ status.error }}</p>
          <p class="muted">{{ t('upstreamView.howTo') }}</p>
          <button type="button" class="upstream-retry" @click="retry">{{ t('upstreamView.retry') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.upstream-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: $bg-main-surface;
}

.page-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.upstream-count {
  min-width: 20px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  border: var(--border-width, 1px) solid currentColor;
  opacity: 0.8;
}

.upstream-frame-wrap {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}

.upstream-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: #0f1115;
}

.upstream-frame-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  text-align: center;
  padding: 24px;
  color: $text-secondary;
  background: $bg-main-surface;

  .muted { opacity: 0.75; max-width: 560px; margin-inline: auto; }
}

.upstream-retry {
  margin-top: 8px;
  padding: 6px 14px;
  border-radius: 8px;
  border: var(--border-width, 1px) solid currentColor;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
</style>
