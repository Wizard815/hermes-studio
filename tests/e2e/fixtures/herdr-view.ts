import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import HerdrView from '../../../packages/client/src/views/hermes/HerdrView.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// The herdr view is real; the API is mocked by the spec and sockets are swallowed.
const Chat = { render: () => h('div', { 'data-testid': 'chat-route' }, 'chat') }
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { name: 'herdr', path: '/herdr', component: HerdrView },
    { name: 'hermes.session', path: '/hermes/session/:sessionId', component: Chat },
    { name: 'hermes.chat', path: '/hermes/chat', component: Chat },
  ],
})
await router.push({ name: 'herdr', query: { tab: new URLSearchParams(location.search).get('tab') || undefined } })
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { display: 'flex', height: '100vh', width: '100vw' } }, [h((router as any).currentRoute.value.name === 'herdr' ? HerdrView : Chat, { key: String((router as any).currentRoute.value.fullPath) })]),
  }) }) }),
})
app.use(createPinia()); app.use(await i18nReady); app.use(router)
;(window as any).herdrFixture = { route: () => router.currentRoute.value.fullPath }
await router.isReady(); app.mount('#app')
