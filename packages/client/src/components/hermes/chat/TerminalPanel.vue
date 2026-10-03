<script lang="ts">
import { ref } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getApiKey, getBaseUrlValue } from "@/api/client";
import type { ITheme } from "@xterm/xterm";

// ─── Terminal themes ────────────────────────────────────────────

const TERMINAL_THEMES: Record<string, { label: string; theme: ITheme }> = {
  default: {
    label: "Default",
    theme: {
      background: "#1a1a2e",
      foreground: "#e0e0e0",
      cursor: "#4cc9f0",
      cursorAccent: "#1a1a2e",
      selectionBackground: "rgba(76, 201, 240, 0.3)",
      black: "#000000", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
      brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
      brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
  "solarized-dark": {
    label: "Solarized Dark",
    theme: {
      background: "#002b36", foreground: "#839496",
      cursor: "#93a1a1", cursorAccent: "#002b36",
      selectionBackground: "rgba(147, 161, 161, 0.3)",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
      brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
  "tokyo-night": {
    label: "Tokyo Night",
    theme: {
      background: "#1a1b26", foreground: "#a9b1d6",
      cursor: "#c0caf5", cursorAccent: "#1a1b26",
      selectionBackground: "rgba(192, 202, 245, 0.2)",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
      brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
  },
  "github-dark": {
    label: "GitHub Dark",
    theme: {
      background: "#0d1117", foreground: "#c9d1d9",
      cursor: "#58a6ff", cursorAccent: "#0d1117",
      selectionBackground: "rgba(88, 166, 255, 0.25)",
      black: "#484f58", red: "#ff7b72", green: "#7ee787", yellow: "#ffa657",
      blue: "#79c0ff", magenta: "#d2a8ff", cyan: "#a5d6ff", white: "#c9d1d9",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
      brightYellow: "#e3b341", brightBlue: "#58a6ff", brightMagenta: "#bc8cff",
      brightCyan: "#79c0ff", brightWhite: "#f0f6fc",
    },
  },
};

const STORAGE_KEY_THEME = "hermes_terminal_theme";

// ─── Types ──────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  shell: string;
  pid: number;
  title: string;
  createdAt: number;
  exited: boolean;
}

// ─── Shared state ───────────────────────────────────────────────
//
// The panel mounts/unmounts with the chat drawer. The connection, PTY
// sessions and xterm instances live at module scope so reopening the panel
// reuses the existing shell instead of spawning (and focusing) a new one.

const sessions = ref<SessionInfo[]>([]);
const activeSessionId = ref<string | null>(null);
const selectedTheme = ref(localStorage.getItem(STORAGE_KEY_THEME) || "default");
const connectionError = ref<string | null>(null);
const isConnecting = ref(false);

const MAX_RECONNECT_ATTEMPTS = 3;
const INITIAL_COMMAND_CHUNK_SIZE = 128;
const INITIAL_COMMAND_CHUNK_DELAY_MS = 8;

let ws: WebSocket | null = null;
const termMap = new Map<string, { term: Terminal; fitAddon: FitAddon; opened: boolean }>();
let activeTerm: Terminal | null = null;
let activeFitAddon: FitAddon | null = null;
let reconnectAttempts = 0;
let disposed = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let translate: (key: string, opts?: Record<string, unknown>) => string = (key) => key;
let notify: (msg: string) => void = () => {};
let mountHook: (() => void) | null = null;
let pendingInitialCommand = "";
let initialCommandSent = false;
const initialCommandTimers = new Set<ReturnType<typeof setTimeout>>();
let currentScopeId = '';

// Terminals are persistent tmux sessions keyed by the chat session, so they
// survive reloads and server restarts. Fall back to a per-browser id when no
// chat session is active.
const TERMINAL_CLIENT_ID_KEY = 'hermes_terminal_client_id';
function terminalClientId(): string {
  try {
    let id = localStorage.getItem(TERMINAL_CLIENT_ID_KEY);
    if (!id) {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(TERMINAL_CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return 'default';
  }
}

function terminalScopeId(): string {
  return currentScopeId || terminalClientId();
}

// ─── WebSocket ──────────────────────────────────────────────────

function formatHostForPort(hostname: string, port: number): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return `${hostname}:${port}`;
  }
  return hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
}

function buildWsUrl(): string {
  const token = getApiKey();
  const base = getBaseUrlValue();
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  params.set('chat_session_id', terminalScopeId());
  const query = `?${params.toString()}`;
  const wsProtocol = base
    ? base.startsWith("https")
      ? "wss:"
      : "ws:"
    : location.protocol === "https:"
      ? "wss:"
      : "ws:";

  if (base) {
    return `${wsProtocol}//${new URL(base).host}/api/hermes/terminal${query}`;
  }

  const directDevPort = import.meta.env.VITE_HERMES_DIRECT_WS_PORT;
  const host = import.meta.env.DEV && directDevPort
    ? formatHostForPort(location.hostname, Number(directDevPort))
    : location.host;
  return `${wsProtocol}//${host}/api/hermes/terminal${query}`;
}

function connect() {
  if (disposed) return;
  // Reuse an existing socket so remounting the panel never spawns a new shell.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    connectionError.value = translate('terminal.connectionFailed');
    isConnecting.value = false;
    return;
  }

  const url = buildWsUrl();
  connectionError.value = null;
  isConnecting.value = true;
  reconnectAttempts++;

  ws = new WebSocket(url);

  ws.onopen = () => {
    if (disposed) return;
    isConnecting.value = false;
    connectionError.value = null;
    reconnectAttempts = 0;
  };

  ws.onmessage = (event) => {
    if (disposed) return;
    const data = typeof event.data === "string" ? event.data : "";
    if (data.charCodeAt(0) === 0x7b) {
      try {
        handleControl(JSON.parse(data));
      } catch {}
    } else {
      activeTerm?.write(data);
    }
  };

  ws.onclose = (event) => {
    if (disposed) return;
    isConnecting.value = false;
    ws = null;

    // 如果是正常关闭（code 1000）或认证失败，不重连
    if (event.code === 1000 || event.code === 1003 || event.code === 1008) {
      connectionError.value = translate('terminal.connectionClosed');
      return;
    }

    // 其他情况尝试重连
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  };

  ws.onerror = (error) => {
    if (disposed) return;
    console.error('[Terminal] WebSocket error:', error);
    connectionError.value = translate('terminal.connectionError');
  };
}

function send(data: object | string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(typeof data === "string" ? data : JSON.stringify(data));
}

// ─── Control message handlers ──────────────────────────────────

function handleControl(msg: any) {
  switch (msg.type) {
    case "created":
      reconnectAttempts = 0;
      sessions.value.push({
        id: msg.id,
        shell: msg.shell,
        pid: msg.pid,
        title: `${msg.shell} #${sessions.value.length + 1}`,
        createdAt: Date.now(),
        exited: false,
      });
      switchSession(msg.id);
      runInitialCommand();
      break;

    case "restored": {
      // Server reattached us to persistent PTYs: rebuild the rail and replay
      // each session's scrollback so nothing is lost across reloads.
      const incoming = Array.isArray(msg.sessions) ? msg.sessions : [];
      const incomingIds = incoming.map((s: any) => s.id);
      const currentIds = sessions.value.map((s) => s.id);
      const sameSet =
        incomingIds.length === currentIds.length &&
        incomingIds.every((id: string) => currentIds.includes(id));

      sessions.value = incoming.map((s: any, index: number) => ({
        id: s.id,
        shell: s.shell,
        pid: s.pid,
        title: `${s.shell} #${index + 1}`,
        createdAt: Date.now(),
        exited: Boolean(s.exited),
      }));

      // Only tear down xterm instances when the session set actually changed.
      // Disposing on every reconnect is what made the pane blank out and flash.
      if (!sameSet) {
        for (const entry of termMap.values()) entry.term.dispose();
        termMap.clear();
        activeSessionId.value = null;
        activeTerm = null;
        activeFitAddon = null;

        for (const s of incoming) {
          if (!s.scrollback) continue;
          const entry = getOrCreateTerm(s.id, null);
          entry.term.write(s.scrollback);
        }
      }

      // Keep whatever the user is actually looking at; only fall back to the
      // server's suggestion when that session no longer exists.
      const keep =
        activeSessionId.value && sessions.value.some((s) => s.id === activeSessionId.value)
          ? activeSessionId.value
          : msg.activeSessionId && sessions.value.some((s: SessionInfo) => s.id === msg.activeSessionId)
            ? msg.activeSessionId
            : sessions.value[0]?.id;
      // switchSession() is a no-op when `keep` is already active, so an
      // unchanged reconnect leaves the live terminal untouched (no flash).
      if (keep) switchSession(keep);
      break;
    }

    case "exited": {
      const s = sessions.value.find((s) => s.id === msg.id);
      if (s) {
        s.exited = true;
        if (activeSessionId.value === msg.id) {
          activeTerm?.write(
            `\r\n\x1b[90m[${translate("terminal.processExited", { code: msg.exitCode })}]\x1b[0m\r\n`,
          );
        }
      }
      break;
    }

    case "error":
      notify(msg.message);
      break;

    case "ping":
      // Server heartbeat. Receiving it is the point: it keeps the upgraded
      // socket from being idle-dropped. Nothing to do here.
      break;
  }
}

// ─── Session actions ────────────────────────────────────────────

function createSession() {
  connect();
  send({ type: "create" });
}

function runInitialCommand() {
  const command = pendingInitialCommand.trim();
  if (!command || initialCommandSent) return;
  initialCommandSent = true;
  scheduleInitialCommandChunk(`${command}\r`, 0, 100);
}

function scheduleInitialCommandChunk(command: string, offset: number, delay: number) {
  const timer = setTimeout(() => {
    initialCommandTimers.delete(timer);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const nextOffset = Math.min(offset + INITIAL_COMMAND_CHUNK_SIZE, command.length);
    send({ type: "input", data: command.slice(offset, nextOffset) });
    if (nextOffset < command.length) {
      scheduleInitialCommandChunk(command, nextOffset, INITIAL_COMMAND_CHUNK_DELAY_MS);
    }
  }, delay);
  initialCommandTimers.add(timer);
}

function getOrCreateTerm(id: string, container: HTMLDivElement | null): { term: Terminal; fitAddon: FitAddon } {
  let entry = termMap.get(id);
  if (!entry) {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { ...TERMINAL_THEMES[selectedTheme.value].theme },
      // tmux owns scrolling via copy-mode (see tmux-sessions.ts), so the
      // viewport scrollback is driven by tmux, not xterm's local buffer.
      scrollback: 10000,
      scrollOnUserInput: true,
      convertEol: false,
      allowProposedApi: true,
      rightClickSelectsWord: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
    // Copy selection on Ctrl/Cmd+C without swallowing SIGINT when nothing is
    // selected. Selecting text still works (tmux mouse mode passes drags with
    // Shift held; xterm handles plain drag selection for non-mouse output).
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true;
      const isCopy = (event.ctrlKey || event.metaKey) && (event.key === 'c' || event.key === 'C');
      if (isCopy && term.hasSelection()) {
        const selection = term.getSelection();
        if (selection) {
          void navigator.clipboard?.writeText(selection).catch(() => {});
          term.clearSelection();
          return false;
        }
      }
      return true;
    });
    entry = { term, fitAddon, opened: false };
    termMap.set(id, entry);
  }
  if (container) mountTerminalInto(container, id);
  return entry;
}

function mountTerminalInto(container: HTMLDivElement, id: string) {
  const entry = termMap.get(id);
  if (!entry) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!entry.opened) {
    entry.term.open(container);
    entry.opened = true;
  } else {
    const termEl = entry.term.element;
    if (termEl) container.appendChild(termEl);
  }
}

function switchSession(id: string) {
  if (activeSessionId.value === id) return;
  activeSessionId.value = id;
  const entry = getOrCreateTerm(id, null);
  activeTerm = entry.term;
  activeFitAddon = entry.fitAddon;
  send({ type: "switch", sessionId: id });
  mountHook?.();
}

function closeSession(id: string) {
  send({ type: "close", sessionId: id });
  sessions.value = sessions.value.filter((s) => s.id !== id);
  const entry = termMap.get(id);
  if (entry) {
    entry.term.dispose();
    termMap.delete(id);
  }
  if (activeSessionId.value === id) {
    const nextSessionId = sessions.value[0]?.id ?? null;
    activeSessionId.value = null;
    activeTerm = null;
    activeFitAddon = null;
    if (nextSessionId) {
      switchSession(nextSessionId);
    } else {
      createSession();
    }
  }
}

function applyThemeToTerms(themeName: string) {
  const themeObj = TERMINAL_THEMES[themeName]?.theme;
  if (!themeObj) return;
  for (const entry of termMap.values()) {
    entry.term.options.theme = { ...themeObj };
  }
}

// ─── Test/reset hook (used by unit tests) ──────────────────────
export function __resetTerminalStoreForTests() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  for (const timer of initialCommandTimers) clearTimeout(timer);
  initialCommandTimers.clear();
  for (const entry of termMap.values()) entry.term.dispose();
  termMap.clear();
  sessions.value = [];
  activeSessionId.value = null;
  activeTerm = null;
  activeFitAddon = null;
  reconnectAttempts = 0;
  initialCommandSent = false;
  disposed = false;
  ws?.close();
  ws = null;
}
</script>

<script setup lang="ts">
import { onMounted, onUnmounted, computed, watch } from "vue";
import "@xterm/xterm/css/xterm.css";
import { NButton, NPopconfirm, NTooltip, useMessage } from "naive-ui";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const message = useMessage();

const props = defineProps<{ visible?: boolean; initialCommand?: string; sessionId?: string | null }>();

translate = (key, opts) => t(key, opts as Record<string, unknown>);
notify = (msg) => message.error(msg);

// ─── Per-instance state ─────────────────────────────────────────

const terminalRef = ref<HTMLDivElement | null>(null);
let resizeObserver: ResizeObserver | null = null;
let touchScrollLastY: number | null = null;
let touchScrollRemainder = 0;
const TOUCH_SCROLL_LINE_PX = 18;

// ─── Computed ──────────────────────────────────────────────────

const terminalBg = computed(
  () => TERMINAL_THEMES[selectedTheme.value]?.theme.background ?? "#1a1a2e",
);
const selectedThemeLabel = computed(
  () => TERMINAL_THEMES[selectedTheme.value]?.label ?? TERMINAL_THEMES.default.label,
);
const selectedThemeInitial = computed(
  () => selectedThemeLabel.value.charAt(0).toUpperCase(),
);

// ─── Terminal mount/unmount ─────────────────────────────────────

function mountActiveTerminal() {
  if (!terminalRef.value || !activeSessionId.value) return;
  const entry = termMap.get(activeSessionId.value);
  if (!entry) return;
  activeTerm = entry.term;
  activeFitAddon = entry.fitAddon;
  mountTerminalInto(terminalRef.value, activeSessionId.value);

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    tryFit();
    sendResize();
  });
  resizeObserver.observe(terminalRef.value);

  setTimeout(() => tryFit(), 50);
  setTimeout(() => tryFit(), 200);
}

function unmountActiveTerminal() {
  if (!terminalRef.value) return;
  const container = terminalRef.value;
  while (container.firstChild) container.removeChild(container.firstChild);
}

function tryFit() {
  if (!activeFitAddon) return;
  try {
    activeFitAddon.fit();
  } catch {}
}

function sendResize() {
  if (!activeTerm || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    send({
      type: "resize",
      cols: activeTerm.cols,
      rows: activeTerm.rows,
    });
  } catch {}
}

function handleTerminalTouchStart(event: TouchEvent) {
  if (event.touches.length !== 1) {
    touchScrollLastY = null;
    touchScrollRemainder = 0;
    return;
  }
  touchScrollLastY = event.touches[0].clientY;
  touchScrollRemainder = 0;
}

function handleTerminalTouchMove(event: TouchEvent) {
  if (!activeTerm || event.touches.length !== 1 || touchScrollLastY === null) return;
  const nextY = event.touches[0].clientY;
  touchScrollRemainder += touchScrollLastY - nextY;
  touchScrollLastY = nextY;

  const lines = Math.trunc(touchScrollRemainder / TOUCH_SCROLL_LINE_PX);
  if (lines === 0) return;

  // tmux runs on the normal screen (smcup@), so xterm.js owns the scrollback
  // and scrollLines() moves it. This also keeps native text selection working.
  activeTerm.scrollLines(lines);
  touchScrollRemainder -= lines * TOUCH_SCROLL_LINE_PX;
  event.preventDefault();
}

function handleTerminalTouchEnd() {
  touchScrollLastY = null;
  touchScrollRemainder = 0;
}

// ─── Theme ───────────────────────────────────────────────────────

function applyTheme(themeName: string) {
  selectedTheme.value = themeName;
  localStorage.setItem(STORAGE_KEY_THEME, themeName);
  applyThemeToTerms(themeName);
}

function cycleTheme() {
  const themeNames = Object.keys(TERMINAL_THEMES);
  const currentIndex = themeNames.indexOf(selectedTheme.value);
  applyTheme(themeNames[(currentIndex + 1 + themeNames.length) % themeNames.length]);
}

// ─── Lifecycle ──────────────────────────────────────────────────

mountHook = mountActiveTerminal;

onMounted(() => {
  pendingInitialCommand = props.initialCommand || "";
  currentScopeId = props.sessionId || "";
  if (activeSessionId.value) {
    // Reattach the existing terminal to this freshly mounted container.
    mountActiveTerminal();
    setTimeout(() => tryFit(), 50);
  }
});

watch(() => props.visible, (visible) => {
  if (visible) {
    currentScopeId = props.sessionId || "";
    connect();
    if (activeSessionId.value) {
      mountActiveTerminal();
      setTimeout(() => tryFit(), 50);
    }
  }
}, { immediate: true });

// Switching chat sessions must switch to that session's terminal scope.
watch(() => props.sessionId, (next) => {
  const scope = next || "";
  if (scope === currentScopeId) return;
  currentScopeId = scope;
  // Drop local xterm state; the server will send the target scope's sessions.
  for (const entry of termMap.values()) entry.term.dispose();
  termMap.clear();
  sessions.value = [];
  activeSessionId.value = null;
  activeTerm = null;
  activeFitAddon = null;
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  reconnectAttempts = 0;
  if (props.visible) connect();
});

onUnmounted(() => {
  // Keep the connection and shells alive across panel remounts. Only drop the
  // per-instance DOM binding so the xterm element can be reattached elsewhere.
  mountHook = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  unmountActiveTerminal();
});
</script>

<template>
  <div class="terminal-panel-drawer">
    <aside class="terminal-session-rail" :aria-label="t('terminal.sessions')">
      <NTooltip trigger="hover" placement="right">
        <template #trigger>
          <button
            class="terminal-rail-button terminal-theme-button"
            type="button"
            :aria-label="selectedThemeLabel"
            @click="cycleTheme"
          >
            {{ selectedThemeInitial }}
          </button>
        </template>
        {{ selectedThemeLabel }}
      </NTooltip>

      <div class="terminal-session-list">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="terminal-session-slot"
          :class="{
            active: session.id === activeSessionId,
            exited: session.exited,
          }"
        >
          <NTooltip trigger="hover" placement="right">
            <template #trigger>
              <button
                class="terminal-session-button"
                type="button"
                :aria-label="session.title"
                :aria-pressed="session.id === activeSessionId"
                @click="switchSession(session.id)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="m7 9 3 3-3 3M13 15h4" />
                </svg>
              </button>
            </template>
            {{ session.title }}
          </NTooltip>
          <NPopconfirm @positive-click="closeSession(session.id)">
            <template #trigger>
              <button
                class="terminal-session-delete"
                type="button"
                :title="t('terminal.closeSession')"
                :aria-label="`${t('terminal.closeSession')}: ${session.title}`"
                @click.stop
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m7 7 10 10M17 7 7 17" />
                </svg>
              </button>
            </template>
            {{ t("terminal.closeSession") }}
          </NPopconfirm>
        </div>
      </div>

      <NTooltip trigger="hover" placement="right">
        <template #trigger>
          <button
            class="terminal-rail-button terminal-add-button"
            type="button"
            :aria-label="t('terminal.newTab')"
            @click="createSession"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </template>
        {{ t("terminal.newTab") }}
      </NTooltip>
    </aside>

    <div class="terminal-main">
      <div class="terminal-container">
        <div v-if="connectionError" class="terminal-state terminal-state-error">
          <span>{{ connectionError }}</span>
          <NButton size="tiny" @click="connect">{{ t("common.retry") }}</NButton>
        </div>
        <div
          v-else-if="sessions.length === 0"
          class="terminal-state"
        >
          {{ isConnecting ? t("common.loading") : t("terminal.noSessions") }}
        </div>
        <div
          ref="terminalRef"
          class="terminal-xterm"
          :style="{ backgroundColor: terminalBg }"
          @touchstart="handleTerminalTouchStart"
          @touchmove="handleTerminalTouchMove"
          @touchend="handleTerminalTouchEnd"
          @touchcancel="handleTerminalTouchEnd"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.terminal-panel-drawer {
  display: flex;
  height: 100%;
  width: 100%;
  min-height: 0;
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.terminal-session-rail {
  width: 48px;
  border-inline-end: 1px solid $border-color;
  background: $bg-sidebar-surface;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
  flex-shrink: 0;
  box-sizing: border-box;
}

.terminal-session-list {
  flex: 1;
  width: 100%;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.terminal-rail-button,
.terminal-session-button,
.terminal-session-delete {
  border: none;
  background: transparent;
  border-radius: $radius-sm;
  cursor: pointer;
  color: $text-secondary;
  display: grid;
  place-items: center;
  transition:
    color $transition-fast,
    background-color $transition-fast,
    opacity $transition-fast;
}

.terminal-rail-button,
.terminal-session-slot,
.terminal-session-button {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
}

.terminal-rail-button,
.terminal-session-button {
  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.terminal-theme-button {
  flex-shrink: 0;
  color: $text-primary;
  background: rgba(var(--accent-primary-rgb), 0.08);
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}

.terminal-add-button {
  flex-shrink: 0;

  svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
  }
}

.terminal-session-slot {
  position: relative;
  border-radius: $radius-sm;

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.12);

    &::before {
      content: "";
      position: absolute;
      left: -6px;
      top: 9px;
      bottom: 9px;
      width: 2px;
      border-radius: 0 2px 2px 0;
      background: var(--accent-primary);
    }
  }

  &.exited {
    opacity: 0.5;
  }

  &:hover .terminal-session-delete,
  &:focus-within .terminal-session-delete {
    opacity: 1;
    pointer-events: auto;
  }
}

.terminal-session-button {
  padding: 0;

  svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
}

.terminal-session-delete {
  position: absolute;
  top: 1px;
  right: 1px;
  z-index: 2;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid $border-color;
  border-radius: 50%;
  color: $text-muted;
  background: $bg-card;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  opacity: 0;
  pointer-events: none;

  svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  &:hover {
    color: $error;
    border-color: rgba(var(--error-rgb), 0.35);
    background: rgba(var(--error-rgb), 0.08);
  }
}

.terminal-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.terminal-container {
  position: relative;
  flex: 1;
  margin: 0;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.terminal-state {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: $text-muted;
  font-size: 12px;
  text-align: center;
  background: $bg-card;
}

.terminal-state-error {
  color: $error;
}

.terminal-xterm {
  flex: 1;
  min-height: 0;
  min-width: 0;
  border-radius: 0;
  overflow: hidden;
  border: 0;

  :deep(.xterm) {
    height: 100%;
    padding: 8px;
  }

  :deep(.xterm-viewport) {
    overflow-y: scroll !important;
    scrollbar-width: thin !important;
    background-color: transparent !important;
  }

  :deep(.xterm-viewport::-webkit-scrollbar) {
    width: 8px;
  }

  :deep(.xterm-viewport::-webkit-scrollbar-thumb) {
    background: rgba(128, 128, 128, 0.4);
    border-radius: 4px;
  }

  :deep(.xterm-viewport::-webkit-scrollbar-track) {
    background: transparent;
  }

  :deep(.xterm-screen) {
    background-color: transparent !important;
  }

  :deep(.xterm-scrollable-element) {
    scrollbar-width: thin !important;
  }
}

@media (max-width: $breakpoint-mobile) {
  .terminal-panel-drawer {
    height: 100%;
    max-height: 100%;
    min-height: 0;
  }

  .terminal-session-rail {
    width: 40px;
    gap: 4px;
    padding: 6px 0;
  }

  .terminal-xterm {
    min-height: 0;

    :deep(.xterm) {
      padding: 6px;
    }

    :deep(.xterm-viewport),
    :deep(.xterm-scrollable-element) {
      touch-action: pan-y;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      scrollbar-width: thin !important;
    }

    :deep(.xterm-viewport::-webkit-scrollbar),
    :deep(.xterm-scrollable-element::-webkit-scrollbar) {
      display: block !important;
      width: 6px !important;
    }
  }
}
</style>
