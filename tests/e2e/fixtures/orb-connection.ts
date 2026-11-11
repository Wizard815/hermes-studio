import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import OrbConnectionPanel from '../../../packages/client/src/components/hermes/connections/OrbConnectionPanel.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// Connections → Pondering Orb is real; the spec mocks the API.
const Chat = { render: () => h('div', { 'data-testid': 'chat-route' }) }
const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: '/', component: OrbConnectionPanel },
  { name: 'hermes.session', path: '/hermes/session/:sessionId', component: Chat },
] })
;(window as any).orbFixture = { route: () => router.currentRoute.value.fullPath }
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, {
    default: () => h('main', { style: { display: 'flex', height: '100vh', width: '100vw' } }, [h((router as any).currentRoute.value.path === '/' ? OrbConnectionPanel : Chat)]),
  }) }),
})
app.use(createPinia()); app.use(await i18nReady); app.use(router)
await router.isReady(); app.mount('#app')
