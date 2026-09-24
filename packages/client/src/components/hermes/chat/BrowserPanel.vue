<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import {
  NButton,
  NInput,
  NSpin,
  useMessage,
  NTooltip,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'
import { getBaseUrlValue, getApiKey } from '@/api/client'
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
}

// ─── Props & Setup ──────────────────────────────────────────────

const props = defineProps<{ visible?: boolean }>()

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
 * Records an agent- or user-requested screenshot into the gallery. Every
 * capture is meaningful, so the only bound is the retained history length.
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
    socketRef.disconnect()
    socketRef = null
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────

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

  // Connect Socket.IO for agent-driven screenshot updates
  connectSocket()

  // Refresh tab state periodically; never capture screenshots on a timer.
  pollingTimer = setInterval(() => {
    void refreshState()
  }, 5000)
})

onUnmounted(() => {
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
            <img
              ref="imageRef"
              :src="'data:image/jpeg;base64,' + currentScreenshot"
              class="browser-screenshot-image"
              alt="Live browser view"
              draggable="false"
            />
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
          <img
            v-for="entry in screenshotHistory"
            :key="entry.id"
            :src="'data:image/jpeg;base64,' + entry.data"
            class="browser-gallery-thumb"
            :alt="formatTimestamp(entry.timestamp)"
            @click="lightboxImage = 'data:image/jpeg;base64,' + entry.data"
          />
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
      <div v-if="lightboxImage" class="browser-lightbox" @click.self="lightboxImage = null">
        <button class="browser-lightbox-close" type="button" @click="lightboxImage = null">×</button>
        <img :src="lightboxImage" class="browser-lightbox-image" alt="Enlarged screenshot" />
      </div>
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
  max-width: 100%;
  max-height: 100%;
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

.browser-gallery-thumb {
  flex: 0 0 120px;
  height: 68px;
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

.browser-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.85);
  padding: 24px;
}

.browser-lightbox-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 20px;
  line-height: 1;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background-color $transition-fast;

  &:hover {
    background: rgba(255, 255, 255, 0.2);
  }
}

.browser-lightbox-image {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

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
