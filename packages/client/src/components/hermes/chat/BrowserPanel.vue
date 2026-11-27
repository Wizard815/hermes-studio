<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import {
  NButton,
  NInput,
  NSpin,
  useMessage,
  NTooltip,
  NSelect,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'
import { getBaseUrlValue, getApiKey } from '@/api/client'
import PinComment from '@/components/common/PinComment.vue'
import ImagePreviewOverlay from './ImagePreviewOverlay.vue'
import { pinCommentTarget } from '@/utils/pin-comment'
import {
  fetchHeadlessBrowserStatus,
  fetchBrowserState,
  createBrowserTab,
  activateBrowserTab,
  closeBrowserTab,
  navigateToUrl as apiNavigateToUrl,
  performNavigationAction,
  captureScreenshot,
  sendManualInput,
  fetchViewportInfo,
  listStoredScreenshots,
  storeScreenshot,
  storedScreenshotUrl,
  deleteStoredScreenshot,
  fetchElementAt,
  fetchBrowserTask,
  fetchBrowserTaskModels,
  startBrowserTask,
  stopBrowserTask,
  type BrowserTaskModel,
  type BrowserTaskState,
  type BrowserTabInfo,
  type ViewportInfo,
} from '@/api/studio/browser'

// ─── Types ──────────────────────────────────────────────────────

interface BrowserTab {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
}

interface ScreenshotEntry {
  id: string
  timestamp: number
  tabId: string
  data: string
  /** Set for server-persisted screenshots; rendered via URL instead of data. */
  storedUrl?: string
}

// ─── Props & Setup ──────────────────────────────────────────────

const props = defineProps<{ visible?: boolean; sessionId?: string | null }>()

const { t } = useI18n()
const message = useMessage()

// ─── State ──────────────────────────────────────────────────────

const browserUnavailable = ref(false)
const tabs = ref<BrowserTab[]>([])
const activeTabId = ref<string | null>(null)
const currentScreenshot = ref<string | null>(null)
const screenshotHistory = ref<ScreenshotEntry[]>([])
const loading = ref(false)
const urlBar = ref('')
const urlInputFocused = ref(false)
const maxTabsReached = ref(false)
const lastUpdated = ref(0)
const lightboxImage = ref<string | null>(null)
const galleryScroll = ref<HTMLElement | null>(null)
const urlInputRef = ref<{ focus?: () => void } | null>(null)
const viewportMetrics = ref<ViewportInfo | null>(null)
const lastPointer = ref<{ x: number; y: number } | null>(null)

const MAX_SCREENSHOT_HISTORY = 20

let pollingTimer: ReturnType<typeof setInterval> | null = null
let socketRef: Socket | null = null

// ─── Computed ───────────────────────────────────────────────────

const currentTab = computed(() => tabs.value.find(t => t.id === activeTabId.value) ?? null)
// Comment mode: a click pins a comment on the page for the chat instead of clicking in it.
const commenting = ref(false)
const canComment = computed(() => !!pinCommentTarget.value)
/** The element under a pinned spot, so the comment says what was pinned. */
function inspectAt(x: number, y: number) {
  return activeTabId.value ? fetchElementAt(activeTabId.value, x, y) : Promise.resolve(null)
}

// ─── Helpers ────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function truncateUrl(url: string, maxLen = 24): string {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/$/, '') || '/'
    const display = path.length > maxLen ? path.slice(0, maxLen) + '…' : path
    return `${u.hostname}${display}`
  } catch {
    return url.length > maxLen ? url.slice(0, maxLen) + '…' : url
  }
}

function isBlankUrl(url: string): boolean {
  const normalized = (url || '').trim().toLowerCase()
  return !normalized || normalized === 'about:blank' || normalized === 'about://blank'
}

/**
 * Updates the live preview image only. Used for user-driven navigation so the
 * viewed page matches the current tab without polluting the capture gallery.
 */
function setPreview(data: string): void {
  currentScreenshot.value = data
  lastUpdated.value = Date.now()
}

/**
 * Records a screenshot and persists it server-side (keyed by chat session) so
 * the gallery survives reloads and is shared across devices.
 */
function pushScreenshot(data: string, tabId: string): void {
  currentScreenshot.value = data
  lastUpdated.value = Date.now()
  screenshotHistory.value.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    tabId,
    data,
  })
  if (screenshotHistory.value.length > MAX_SCREENSHOT_HISTORY) {
    screenshotHistory.value.length = MAX_SCREENSHOT_HISTORY
  }
  void nextTick(() => {
    if (galleryScroll.value) galleryScroll.value.scrollTop = 0
  })

  const sessionId = props.sessionId
  if (!sessionId) return
  const active = tabs.value.find(t => t.id === activeTabId.value)
  void storeScreenshot(sessionId, data, {
    tabId,
    url: active?.url,
    title: active?.title,
  }).then(meta => {
    if (!meta) return
    // Replace the transient data URL entry with the persisted one so the
    // gallery keeps working after a reload.
    const index = screenshotHistory.value.findIndex(entry => entry.data === data && !entry.storedUrl)
    if (index >= 0) {
      screenshotHistory.value[index] = {
        id: meta.id,
        timestamp: meta.timestamp,
        tabId: meta.tabId || tabId,
        data,
        storedUrl: storedScreenshotUrl(sessionId, meta.id),
      }
    }
  }).catch(() => {
    // Persistence failure must not break the live gallery.
  })
}

async function loadPersistedScreenshots(): Promise<void> {
  const sessionId = props.sessionId
  if (!sessionId) return
  try {
    const stored = await listStoredScreenshots(sessionId)
    screenshotHistory.value = stored.map(meta => ({
      id: meta.id,
      timestamp: meta.timestamp,
      tabId: meta.tabId || '',
      data: '',
      storedUrl: storedScreenshotUrl(sessionId, meta.id),
    }))
  } catch {
    // Non-fatal: the gallery just stays empty.
  }
}

async function handleDeleteScreenshot(entry: ScreenshotEntry): Promise<void> {
  const sessionId = props.sessionId
  screenshotHistory.value = screenshotHistory.value.filter(e => e.id !== entry.id)
  if (!sessionId || !entry.storedUrl) return
  try {
    await deleteStoredScreenshot(sessionId, entry.id)
  } catch {
    // Best-effort delete.
  }
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  try {
    new URL(trimmed)
    return trimmed
  } catch {
    // Try adding protocol
    if (trimmed.includes('.') && !trimmed.startsWith('http')) {
      return `https://${trimmed}`
    }
    // Treat as search query
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
  }
}

async function refreshState(): Promise<void> {
  try {
    const state = await fetchBrowserState()
    const maxLimit = state.maxTabs ?? 5
    maxTabsReached.value = (state.tabs ?? []).length >= maxLimit

    tabs.value = (state.tabs ?? []).map((t: BrowserTabInfo): BrowserTab => ({
      id: t.id,
      title: t.title,
      url: t.url,
      loading: t.loading ?? false,
      canGoBack: t.canGoBack ?? false,
      canGoForward: t.canGoForward ?? false,
      crashed: t.crashed ?? false,
    }))

    if (state.activeTabId) {
      activeTabId.value = state.activeTabId
    }

    if (tabs.value.length > 0 && !activeTabId.value) {
      activeTabId.value = tabs.value[0].id
    }

    // Do not overwrite what the user is typing, and never re-fill the field
    // with an empty about:blank placeholder.
    const active = tabs.value.find(t => t.id === activeTabId.value)
    if (active && !urlInputFocused.value && !isBlankUrl(active.url)) {
      urlBar.value = active.url
    }
  } catch {
    // Silently fail — polling errors are expected when server is down
  }
}

// ─── Tab Management ─────────────────────────────────────────────

async function handleNewTab(): Promise<void> {
  if (maxTabsReached.value) return
  try {
    await createBrowserTab({ activate: true })
    await refreshState()
    urlBar.value = ''
    urlInputFocused.value = true
    await nextTick()
    urlInputRef.value?.focus?.()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function handleActivateTab(tabId: string): Promise<void> {
  if (tabId === activeTabId.value) return
  try {
    await activateBrowserTab(tabId)
    activeTabId.value = tabId
    const tab = tabs.value.find(t => t.id === tabId)
    urlBar.value = tab && !isBlankUrl(tab.url) ? tab.url : ''
    await refreshState()
    void refreshPreview()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function handleCloseTab(tabId: string): Promise<void> {
  try {
    await closeBrowserTab(tabId)
    if (activeTabId.value === tabId) {
      activeTabId.value = tabs.value.find(t => t.id !== tabId)?.id ?? null
    }
    await refreshState()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

// ─── Navigation ─────────────────────────────────────────────────

async function handleNavigate(): Promise<void> {
  if (!activeTabId.value) return
  const normalized = normalizeUrl(urlBar.value)
  if (!normalized) return
  try {
    loading.value = true
    urlInputFocused.value = false
    await apiNavigateToUrl(activeTabId.value, normalized)
    urlBar.value = normalized
    await refreshState()
    void refreshPreview()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function handleNavAction(action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> {
  if (!activeTabId.value) return
  try {
    loading.value = true
    await performNavigationAction(activeTabId.value, action)
    await refreshState()
    void refreshPreview()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

// ─── Screenshots ────────────────────────────────────────────────
//
// The live preview refreshes whenever the user navigates or reloads a tab
// (silently, and without adding to the gallery). The gallery only gains an
// entry when the agent requests a screenshot (server 'browser.screenshot'
// event) or the user clicks the manual capture button.

async function refreshPreview(): Promise<void> {
  if (!activeTabId.value) return
  try {
    const result = await captureScreenshot(activeTabId.value)
    if (result?.data) setPreview(result.data)
    void fetchViewportInfo(activeTabId.value)
      .then(info => { viewportMetrics.value = info })
      .catch(() => {})
  } catch {
    // Preview refresh is best-effort
  }
}

async function handleManualCapture(): Promise<void> {
  if (!activeTabId.value) return
  try {
    const result = await captureScreenshot(activeTabId.value)
    if (result?.data) pushScreenshot(result.data, result.tabId || activeTabId.value)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

// ─── Manual Input (coordinate-based live view control) ──────────

const viewportRef = ref<HTMLElement | null>(null)
const imageRef = ref<HTMLImageElement | null>(null)
const interactiveBusy = ref(false)
let wheelAccumX = 0
let wheelAccumY = 0
let wheelFlushTimer: ReturnType<typeof setTimeout> | null = null
let clickRefreshTimer: ReturnType<typeof setTimeout> | null = null

/** Map a pointer event to normalized viewport coordinates (0..1). */
function normalizedPoint(event: MouseEvent): { x: number; y: number } | null {
  const target = imageRef.value || viewportRef.value
  if (!target) return null
  const rect = target.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const x = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
  const y = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1)
  return { x, y }
}

async function sendInput(action: { type: string; [key: string]: any }): Promise<void> {
  if (!activeTabId.value) return
  try {
    const result = await sendManualInput(activeTabId.value, action)
    if (result?.viewport) viewportMetrics.value = result.viewport
    if (result?.tab) {
      const idx = tabs.value.findIndex(t => t.id === result.tab.id)
      if (idx >= 0) {
        tabs.value[idx] = { ...tabs.value[idx], ...result.tab }
      }
      urlBar.value = isBlankUrl(result.tab.url) ? urlBar.value : result.tab.url
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** Refresh the live preview shortly after an interaction settles. */
function schedulePreviewRefresh(delay = 450): void {
  if (clickRefreshTimer) clearTimeout(clickRefreshTimer)
  clickRefreshTimer = setTimeout(() => {
    clickRefreshTimer = null
    void refreshPreview()
  }, delay)
}

async function handleViewportClick(event: MouseEvent): Promise<void> {
  const point = normalizedPoint(event)
  if (!point) return
  viewportRef.value?.focus?.()
  interactiveBusy.value = true
  try {
    await sendInput({ type: 'click', x: point.x, y: point.y })
    schedulePreviewRefresh()
  } finally {
    interactiveBusy.value = false
  }
}

async function handleViewportDblClick(event: MouseEvent): Promise<void> {
  const point = normalizedPoint(event)
  if (!point) return
  interactiveBusy.value = true
  try {
    await sendInput({ type: 'click', x: point.x, y: point.y, double: true })
    schedulePreviewRefresh()
  } finally {
    interactiveBusy.value = false
  }
}

async function handleViewportMove(event: MouseEvent): Promise<void> {
  lastPointer.value = normalizedPoint(event)
}

async function handleViewportWheel(event: WheelEvent): Promise<void> {
  wheelAccumX += event.deltaX
  wheelAccumY += event.deltaY
  const point = normalizedPoint(event) || { x: 0.5, y: 0.5 }
  if (wheelFlushTimer) clearTimeout(wheelFlushTimer)
  wheelFlushTimer = setTimeout(async () => {
    wheelFlushTimer = null
    const dx = wheelAccumX
    const dy = wheelAccumY
    wheelAccumX = 0
    wheelAccumY = 0
    if (!dx && !dy) return
    await sendInput({ type: 'scroll', x: point.x, y: point.y, delta_x: dx, delta_y: dy })
    schedulePreviewRefresh(500)
  }, 60)
}

async function handleViewportKeydown(event: KeyboardEvent): Promise<void> {
  const key = event.key
  // Forward typed characters; printable single chars go through type,
  // named keys (Enter, Backspace, arrows…) go through press.
  if (key.length === 1) {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    await sendInput({ type: 'type', text: key })
    schedulePreviewRefresh(350)
    return
  }
  const allowed = new Set([
    'Enter', 'Backspace', 'Tab', 'Escape', 'Delete',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', ' ',
  ])
  if (!allowed.has(key)) return
  event.preventDefault()
  await sendInput({ type: 'press', key: key === ' ' ? 'Space' : key })
  schedulePreviewRefresh(key === 'Enter' ? 900 : 350)
}

// ─── Browser tasks (browser-use, docs/browser-tasks.md) ────────
// A task runs on this same browser, so the view, tabs and pin comments follow it.

const TASK_MODEL_KEY = 'studio.browserTask.model'
const taskSectionShown = ref(false)
const taskAvailable = ref(false)
const taskUnavailableReason = ref('')
const taskText = ref('')
const taskModel = ref<string | null>(null)
const taskModels = ref<BrowserTaskModel[]>([])
const browserTask = ref<BrowserTaskState | null>(null)
const taskStarting = ref(false)
const taskRunning = computed(() => browserTask.value?.status === 'running')
const taskModelOptions = computed(() => taskModels.value.map(m => ({ label: m.id, value: m.id })))
const taskStatusLabel = computed(() => {
  switch (browserTask.value?.status) {
    case 'running': return t('browser.taskRunning', 'Working')
    case 'completed': return browserTask.value?.success === false ? t('browser.taskUnfinished', 'Finished, not done') : t('browser.taskDone', 'Done')
    case 'max_steps': return t('browser.taskMaxSteps', 'Stopped at the step limit')
    case 'timeout': return t('browser.taskTimeout', 'Ran out of time')
    case 'stopped': return t('browser.taskStopped', 'Stopped')
    case 'error': return t('browser.taskFailed', 'Failed')
    default: return ''
  }
})

async function loadBrowserTask(): Promise<void> {
  try {
    const state = await fetchBrowserTask()
    taskSectionShown.value = true
    taskAvailable.value = state.available
    taskUnavailableReason.value = state.reason || ''
    browserTask.value = state.task
  } catch {
    // Not a super administrator, or an older server: no task bar.
    taskSectionShown.value = false
  }
}

async function loadBrowserTaskModels(): Promise<void> {
  try {
    const { models, default: preferred } = await fetchBrowserTaskModels()
    taskModels.value = models
    let saved: string | null = null
    try { saved = localStorage.getItem(TASK_MODEL_KEY) } catch { /* private window */ }
    const ids = new Set(models.map(m => m.id))
    taskModel.value = [saved, preferred, models[0]?.id].find((id): id is string => !!id && ids.has(id)) ?? null
  } catch {
    taskModels.value = []
  }
}

watch(taskModel, id => {
  if (!id) return
  try { localStorage.setItem(TASK_MODEL_KEY, id) } catch { /* private window */ }
})

async function handleRunTask(): Promise<void> {
  const text = taskText.value.trim()
  if (!text || !taskModel.value || taskRunning.value || taskStarting.value) return
  taskStarting.value = true
  try {
    browserTask.value = await startBrowserTask(text, taskModel.value)
    taskText.value = ''
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    taskStarting.value = false
  }
}

async function handleStopTask(): Promise<void> {
  try {
    const { task } = await stopBrowserTask()
    if (task) browserTask.value = task
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

// While a task runs, read it every 2 s too: the socket event can be missed
// (a reconnect, a proxy that drops websockets).
let taskPollTimer: ReturnType<typeof setInterval> | null = null
watch(taskRunning, running => {
  if (taskPollTimer) { clearInterval(taskPollTimer); taskPollTimer = null }
  if (running) taskPollTimer = setInterval(() => { void onBrowserTaskEvent() }, 2000)
})

/** Each step of a running task: read it, and show the page it left. */
async function onBrowserTaskEvent(): Promise<void> {
  if (!taskSectionShown.value) return
  await loadBrowserTask()
  await refreshState()
  void refreshPreview()
}

// ─── Socket.IO ──────────────────────────────────────────────────

function connectSocket(): void {
  try {
    const token = getApiKey()
    const baseUrl = getBaseUrlValue()
    const socketUrl = baseUrl || undefined
    const opts = {
      auth: token ? { token } : {},
      transports: ['websocket', 'polling'],
    }

    socketRef = io(socketUrl, opts)

    socketRef.on('browser.screenshot', (payload: { data: string; tabId: string }) => {
      if (payload?.data) {
        pushScreenshot(payload.data, payload.tabId)
      }
    })

    socketRef.on('browser.task', () => { void onBrowserTaskEvent() })

    socketRef.on('connect_error', () => {
      // Graceful degradation — Socket.IO may not be available
      socketRef = null
    })
  } catch {
    // Socket.IO import failed or connection errored — no crash
    socketRef = null
  }
}

function disconnectSocket(): void {
  if (socketRef) {
    socketRef.off('browser.screenshot')
    socketRef.off('browser.task')
    socketRef.disconnect()
    socketRef = null
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────

watch(() => props.sessionId, () => {
  screenshotHistory.value = []
  void loadPersistedScreenshots()
})

onMounted(async () => {
  // Check availability
  try {
    const status = await fetchHeadlessBrowserStatus()
    if (!status.available) {
      browserUnavailable.value = true
      return
    }
  } catch {
    browserUnavailable.value = true
    return
  }

  browserUnavailable.value = false

  // Fetch initial state
  await refreshState()

  // Restore persisted screenshots for this chat session
  await loadPersistedScreenshots()

  // The browser-use task bar (super administrators)
  await loadBrowserTask()
  if (taskSectionShown.value) void loadBrowserTaskModels()

  // Connect Socket.IO for agent-driven screenshot updates
  connectSocket()

  // Refresh tab state periodically; never capture screenshots on a timer.
  pollingTimer = setInterval(() => {
    void refreshState()
  }, 5000)
})

onUnmounted(() => {
  if (taskPollTimer) {
    clearInterval(taskPollTimer)
    taskPollTimer = null
  }
  if (pollingTimer) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
  disconnectSocket()
})
</script>

<template>
  <div class="browser-panel-content">
    <!-- Error State -->
    <div v-if="browserUnavailable" class="browser-unavailable">
      <svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M12 8v4M12 16h.01" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <p class="browser-unavailable-text">
        {{ t('browser.unavailable', 'Headless browser service is not available') }}
      </p>
    </div>

    <!-- Normal Content -->
    <template v-else>
      <!-- Header Bar -->
      <div class="browser-header">
        <!-- Tab Strip -->
        <div class="browser-tabs-bar">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            class="browser-tab-btn"
            :class="{ active: tab.id === activeTabId }"
            @click="handleActivateTab(tab.id)"
          >
            <span class="browser-tab-title">{{ tab.title || truncateUrl(tab.url) }}</span>
            <span
              class="browser-tab-close"
              role="button"
              tabindex="0"
              @click.stop="handleCloseTab(tab.id)"
              @keydown.enter.stop="handleCloseTab(tab.id)"
              @keydown.escape.stop="handleCloseTab(tab.id)"
            >&times;</span>
          </button>
          <NTooltip trigger="hover">
            <template #trigger>
              <button
                type="button"
                class="browser-new-tab-btn"
                :disabled="maxTabsReached"
                :aria-label="t('browser.newTab', 'New Tab')"
                @click="handleNewTab"
              >
                +
              </button>
            </template>
            {{ maxTabsReached ? t('browser.maxTabs', 'Maximum tabs reached') : t('browser.newTab', 'New Tab') }}
          </NTooltip>
        </div>

        <!-- URL Bar Row -->
        <div class="browser-url-bar">
          <NInput
            ref="urlInputRef"
            v-model:value="urlBar"
            class="browser-url-input"
            size="small"
            :placeholder="t('browser.addressPlaceholder', 'Search or enter an address')"
            @keyup.enter="handleNavigate"
            @focus="urlInputFocused = true"
            @blur="urlInputFocused = false"
          />
          <NButton size="small" quaternary circle @click="handleNavAction('back')" :disabled="!currentTab?.canGoBack">
            <svg viewBox="0 0 24 24" class="browser-nav-icon"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </NButton>
          <NButton size="small" quaternary circle @click="handleNavAction('forward')" :disabled="!currentTab?.canGoForward">
            <svg viewBox="0 0 24 24" class="browser-nav-icon"><path d="M9 18l6-6-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </NButton>
          <NButton size="small" quaternary circle @click="handleNavAction('reload')" :disabled="currentTab?.loading ?? false">
            <svg viewBox="0 0 24 24" class="browser-nav-icon"><path d="M 1 4 a 7.5 7.5 0 1 1 -1.34 5.88" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M20 4 v6 h-6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </NButton>
          <NButton size="small" type="primary" :loading="loading" @click="handleNavigate">
            {{ t('common.go', 'Go') }}
          </NButton>
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton size="small" quaternary circle @click="handleManualCapture">
                <svg viewBox="0 0 24 24" class="browser-nav-icon">
                  <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                  <circle cx="12" cy="13" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/>
                </svg>
              </NButton>
            </template>
            {{ t('browser.capture', 'Capture screenshot') }}
          </NTooltip>
          <NButton
            v-if="canComment && currentScreenshot"
            size="small"
            :type="commenting ? 'primary' : 'default'"
            :secondary="commenting"
            quaternary
            :aria-pressed="commenting"
            data-testid="browser-pin-comment"
            @click="commenting = !commenting"
          >{{ commenting ? t('pinComment.commenting') : t('pinComment.comment') }}</NButton>
        </div>
      </div>

      <!-- Browser task (browser-use): runs on this browser, the view follows it -->
      <div v-if="taskSectionShown" class="browser-task" data-testid="browser-task">
        <div class="browser-task-row">
          <NInput
            v-model:value="taskText"
            size="small"
            class="browser-task-input"
            :placeholder="t('browser.taskPlaceholder', 'Ask the browser to do something…')"
            :input-props="{ 'aria-label': t('browser.taskLabel', 'Browser task') }"
            :disabled="taskRunning || !taskAvailable"
            data-testid="browser-task-input"
            @keydown.enter.exact.prevent="handleRunTask"
          />
          <NSelect
            v-model:value="taskModel"
            size="small"
            filterable
            class="browser-task-model"
            :options="taskModelOptions"
            :placeholder="t('browser.taskModel', 'Model')"
            :disabled="taskRunning || !taskAvailable"
            :input-props="{ 'aria-label': t('browser.taskModelLabel', 'Model for browser tasks') }"
            data-testid="browser-task-model"
          />
          <NButton
            v-if="!taskRunning"
            size="small"
            type="primary"
            :loading="taskStarting"
            :disabled="!taskAvailable || !taskText.trim() || !taskModel"
            data-testid="browser-task-run"
            @click="handleRunTask"
          >{{ t('browser.taskRun', 'Run') }}</NButton>
          <NButton v-else size="small" data-testid="browser-task-stop" @click="handleStopTask">{{ t('browser.taskStop', 'Stop') }}</NButton>
        </div>
        <p v-if="!taskAvailable" class="browser-task-note">
          {{ t('browser.taskUnavailable', 'Browser tasks need browser-use on the server.') }}
          <span v-if="taskUnavailableReason"> {{ taskUnavailableReason }}</span>
        </p>
        <div v-if="browserTask" class="browser-task-log" role="status" aria-live="polite" data-testid="browser-task-log">
          <div class="browser-task-status">
            <span class="browser-task-badge" :class="browserTask.status">{{ taskStatusLabel }}</span>
            <span>{{ t('browser.taskStepsLabel', 'Steps') }}: {{ browserTask.steps.length }}</span>
            <span v-if="browserTask.costUsd != null">· ${{ browserTask.costUsd.toFixed(4) }}</span>
            <span class="browser-task-what" :title="browserTask.task">· {{ browserTask.task }}</span>
          </div>
          <ol v-if="browserTask.steps.length" class="browser-task-steps">
            <li v-for="(step, i) in browserTask.steps.slice(-5)" :key="`${step.at}-${i}`" :value="Math.max(browserTask.steps.length - 5, 0) + i + 1"><code>{{ step.text }}</code></li>
          </ol>
          <p v-if="browserTask.result" class="browser-task-result" data-testid="browser-task-result">{{ browserTask.result }}</p>
          <p v-if="browserTask.error && browserTask.status !== 'completed'" class="browser-task-error">{{ browserTask.error }}</p>
        </div>
      </div>

      <!-- Live View Area -->
      <div class="browser-live-view">
        <!-- Loading overlay -->
        <div v-if="loading" class="browser-loading-overlay">
          <NSpin size="small" />
          <span class="browser-loading-text">{{ t('browser.navigating', 'Navigating…') }}</span>
        </div>

        <!-- Interactive live view: clicks/typing are forwarded to the page -->
        <template v-if="currentScreenshot">
          <div
            ref="viewportRef"
            class="browser-viewport"
            :class="{ interacting: interactiveBusy }"
            role="img"
            :aria-label="t('browser.liveView', 'Live browser view')"
            @click="handleViewportClick"
            @dblclick="handleViewportDblClick"
            @mousemove="handleViewportMove"
            @wheel.prevent="handleViewportWheel"
            @keydown="handleViewportKeydown"
            tabindex="0"
          >
            <PinComment :name="currentTab?.url || currentTab?.title || 'the browser'" :active="commenting" :inspect="inspectAt" @sent="message.success(t('pinComment.sent'))" @error="text => message.error(text)">
              <img
                ref="imageRef"
                :src="'data:image/jpeg;base64,' + currentScreenshot"
                class="browser-screenshot-image"
                alt="Live browser view"
                draggable="false"
              />
            </PinComment>
          </div>
        </template>

        <!-- Placeholder -->
        <div v-else class="browser-placeholder">
          <svg viewBox="0 0 24 24" class="browser-placeholder-icon" aria-hidden="true">
            <rect x="2" y="3" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="5" cy="6" r="0.75" fill="currentColor"/>
            <circle cx="7.5" cy="6" r="0.75" fill="currentColor"/>
            <circle cx="10" cy="6" r="0.75" fill="currentColor"/>
            <line x1="2" y1="18" x2="22" y2="18" stroke="currentColor" stroke-width="1.5"/>
          </svg>
          <p>{{ t('browser.noScreenshots', 'No screenshots captured yet. The AI agent will populate this area.') }}</p>
        </div>
      </div>

      <!-- Screenshot Gallery -->
      <div class="browser-gallery-section">
        <div class="browser-gallery-header">
          <span class="browser-gallery-label">{{ t('browser.capturedScreenshots', 'Captured Screenshots') }}</span>
          <span v-if="screenshotHistory.length" class="browser-gallery-count">{{ screenshotHistory.length }}</span>
        </div>
        <div v-if="screenshotHistory.length" ref="galleryScroll" class="browser-gallery-scroll">
          <div
            v-for="entry in screenshotHistory"
            :key="entry.id"
            class="browser-gallery-item"
          >
            <img
              :src="entry.storedUrl || ('data:image/jpeg;base64,' + entry.data)"
              class="browser-gallery-thumb"
              :alt="formatTimestamp(entry.timestamp)"
              @click="lightboxImage = entry.storedUrl || ('data:image/jpeg;base64,' + entry.data)"
            />
            <button
              type="button"
              class="browser-gallery-delete"
              :title="t('common.delete', 'Delete')"
              :aria-label="t('common.delete', 'Delete')"
              @click.stop="handleDeleteScreenshot(entry)"
            >&times;</button>
          </div>
        </div>
        <div v-else class="browser-gallery-empty">
          {{ t('browser.galleryEmpty', 'Screenshots taken during agent runs will appear here') }}
        </div>
      </div>
    </template>
  </div>

  <!-- Lightbox Overlay -->
  <Teleport to="body">
    <transition name="lightbox-fade">
      <ImagePreviewOverlay v-if="lightboxImage" :src="lightboxImage" :alt="t('browser.capturedScreenshots', 'Captured Screenshots')" @close="lightboxImage = null" />
    </transition>
  </Teleport>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

// ─── Main Container ─────────────────────────────────────────────

.browser-panel-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: $bg-primary;
  color: $text-primary;
}

// ─── Unavailable State ──────────────────────────────────────────

.browser-unavailable {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  color: $text-secondary;
  font-size: 13px;

  svg {
    opacity: 0.4;
    color: $text-muted;
  }
}

.browser-unavailable-text {
  margin: 0;
  line-height: 1.5;
}

// ─── Header ─────────────────────────────────────────────────────

.browser-header {
  flex: 0 0 auto;
  border-bottom: 1px solid $border-color;
}

.browser-tabs-bar {
  display: flex;
  align-items: stretch;
  gap: 4px;
  padding: 4px;
  overflow-x: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.browser-tab-btn {
  flex: 0 0 auto;
  min-width: 80px;
  max-width: 200px;
  height: 30px;
  padding: 0 12px 0 10px;
  border: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  font-family: inherit;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: background-color $transition-fast, color $transition-fast;
  position: relative;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    background: rgba(122, 162, 247, 0.1);
    color: #7aa2f7;

    &::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 4px;
      right: 4px;
      height: 2px;
      background: #7aa2f7;
      border-radius: 2px 2px 0 0;
    }
  }

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}

.browser-tab-title {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.browser-tab-close {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;
  opacity: 0.5;
  transition: opacity $transition-fast, background-color $transition-fast;

  &:hover {
    opacity: 1;
    background: rgba(var(--error-rgb), 0.15);
    color: $error;
  }
}

.browser-new-tab-btn {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  font-size: 16px;
  font-weight: 300;
  line-height: 1;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background-color $transition-fast, color $transition-fast;

  &:hover:not(:disabled) {
    background: rgba(var(--accent-primary-rgb), 0.08);
    color: $text-primary;
  }

  &:disabled {
    opacity: 0.3;
    cursor: default;
  }
}

// ─── URL Bar ────────────────────────────────────────────────────

.browser-url-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 4px 4px 8px;
  border-top: 1px solid $border-color;
}

.browser-url-input {
  flex: 1;

  :deep(.n-input) {
    --n-border: 1px solid $border-color;
    --n-box-shadow: none;
  }

  :deep(.n-input__border) {
    border: 1px solid $border-color;
    border-radius: 6px;
  }

  :deep(.n-input__input-el) {
    background: $bg-input;
    color: $text-primary;
    font-size: 12px;
  }
}

.browser-nav-icon {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

// ─── Live View ──────────────────────────────────────────────────

.browser-live-view {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0d0e14;
  overflow: hidden;
}

.browser-loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(13, 14, 20, 0.7);
  color: $text-secondary;
  font-size: 13px;
}

.browser-loading-text {
  margin: 0;
}

.browser-viewport {
  position: relative;
  container-type: size;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: default;
  outline: none;
  overflow: hidden;

  &:focus-visible {
    box-shadow: inset 0 0 0 2px var(--accent-primary);
  }

  &.interacting {
    cursor: progress;
  }
}

.browser-screenshot-image {
  max-width: 100cqw;
  max-height: 100cqh;
  object-fit: contain;
  display: block;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}

.browser-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  color: $text-muted;
  font-size: 13px;

  .browser-placeholder-icon {
    width: 48px;
    height: 48px;
    opacity: 0.3;
    color: $text-secondary;
  }
}

// ─── Gallery ────────────────────────────────────────────────────

// ─── Browser task (browser-use) ─────────────────────────────────

.browser-task {
  flex: 0 0 auto;
  border-bottom: 1px solid $border-color;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.browser-task-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.browser-task-input {
  flex: 1 1 220px;
  min-width: 0;
}

.browser-task-model {
  flex: 0 1 220px;
  min-width: 140px;
}

.browser-task-note,
.browser-task-result,
.browser-task-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
}

.browser-task-note { color: $text-muted; }
.browser-task-error { color: $error; }

.browser-task-result {
  white-space: pre-wrap;
  max-height: 96px;
  overflow: auto;
}

.browser-task-log {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.browser-task-status {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: $text-secondary;
  min-width: 0;

  > span { white-space: nowrap; }
}

.browser-task-what {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.browser-task-badge {
  padding: 1px 6px;
  border-radius: $radius-sm;
  border: 1px solid $border-color;
  color: $text-primary;
  white-space: nowrap;

  &.running { border-color: $info; }
  &.completed { border-color: $success; }
  &.error, &.timeout, &.max_steps { border-color: $error; }
}

.browser-task-steps {
  margin: 0;
  padding-left: 22px;
  font-size: 11px;
  color: $text-secondary;
  max-height: 90px;
  overflow: auto;

  code {
    font-family: $font-code;
    word-break: break-all;
  }
}

.browser-gallery-section {
  flex: 0 0 auto;
  border-top: 1px solid $border-color;
  padding: 8px;
  max-height: 150px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.browser-gallery-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.browser-gallery-label {
  font-size: 11px;
  font-weight: 600;
  color: $text-secondary;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.browser-gallery-count {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: $text-secondary;
}

.browser-gallery-scroll {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  display: flex;
  gap: 8px;
  padding-bottom: 4px;
  scrollbar-width: thin;
  scrollbar-color: $border-color transparent;

  &::-webkit-scrollbar {
    height: 4px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: $border-color;
    border-radius: 2px;
  }
}

.browser-gallery-item {
  position: relative;
  flex: 0 0 120px;
  height: 68px;
}

.browser-gallery-delete {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
  opacity: 0;
  transition: opacity $transition-fast;

  &:hover {
    background: rgba(220, 60, 60, 0.9);
  }
}

.browser-gallery-item:hover .browser-gallery-delete {
  opacity: 1;
}

.browser-gallery-thumb {
  flex: 0 0 120px;
  height: 68px;
  width: 100%;
  object-fit: cover;
  border-radius: 4px;
  cursor: pointer;
  transition: transform $transition-fast;
  border: 1px solid $border-color;

  &:hover {
    transform: scale(1.1);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }
}

.browser-gallery-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 32px;
  opacity: 0.5;
  font-style: italic;
  font-size: 11px;
  color: $text-secondary;
  text-align: center;
}

// ─── Lightbox ───────────────────────────────────────────────────




.lightbox-fade-enter-active,
.lightbox-fade-leave-active {
  transition: opacity $transition-normal;
}

.lightbox-fade-enter-from,
.lightbox-fade-leave-to {
  opacity: 0;
}

// ─── Responsive ─────────────────────────────────────────────────

@media (max-width: $breakpoint-mobile) {
  .browser-tabs-bar {
    padding: 2px;
  }

  .browser-tab-btn {
    min-width: 64px;
    font-size: 11px;
  }

  .browser-gallery-section {
    max-height: 120px;
    padding: 6px;
  }

  .browser-gallery-thumb {
    width: 100px;
    height: 56px;
  }
}
</style>
