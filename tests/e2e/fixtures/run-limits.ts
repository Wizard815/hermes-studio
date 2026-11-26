import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import RunLimitsSettings from '../../../packages/client/src/components/hermes/settings/RunLimitsSettings.vue'
import RunLimitBanner from '../../../packages/client/src/components/hermes/run-limits/RunLimitBanner.vue'
import { useSessionStateStore } from '../../../packages/client/src/stores/hermes/session-state'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// Settings → Agent → Run limits and a chat's limit card; the API is mocked by the spec.
const pinia = createPinia()
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { padding: '16px', maxWidth: '900px' } }, [h(RunLimitsSettings), h(RunLimitBanner, { sessionId: 'chat-1' })]),
  }) }) }),
})
app.use(pinia); app.use(await i18nReady)
const state = useSessionStateStore(pinia)
state.sessions.set('chat-1', {
  sessionId: 'chat-1', working: false, blocked: true, backgroundPending: 0, lastMessageId: 1, readMessageId: 1, unread: false,
  limit: { kind: 'loop', limit: 5, value: 5, detail: 'terminal({"command":"ls"})', via: 'run', at: Date.now(), suggested: 10 },
})
;(window as any).__clearLimit = () => { state.sessions.set('chat-1', { ...state.sessions.get('chat-1')!, blocked: false, limit: undefined }) }
app.mount('#app')
