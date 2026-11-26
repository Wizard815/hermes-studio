import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import OmiConnectionPanel from '../../../packages/client/src/components/hermes/connections/OmiConnectionPanel.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// Connections → Omi is real; the spec mocks the API.
const Chat = { render: () => h('div', { 'data-testid': 'chat-route' }) }
const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: '/', component: OmiConnectionPanel },
  { name: 'hermes.session', path: '/hermes/session/:sessionId', component: Chat },
  { name: 'hermes.mcp', path: '/hermes/mcp', component: Chat },
] })
;(window as any).omiFixture = { route: () => router.currentRoute.value.fullPath }
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { display: 'flex', height: '100vh', width: '100vw' } }, [h((router as any).currentRoute.value.path === '/' ? OmiConnectionPanel : Chat)]),
  }) }) }),
})
app.use(createPinia()); app.use(await i18nReady); app.use(router)
await router.isReady(); app.mount('#app')
