import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import ChatImportView from '../../../packages/client/src/views/hermes/ChatImportView.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// The Import chats page is real; the spec mocks the API.
const Chat = { render: () => h('div', { 'data-testid': 'chat-route' }) }
const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: '/', component: ChatImportView },
  { name: 'hermes.session', path: '/hermes/session/:sessionId', component: Chat },
  { name: 'hermes.chat', path: '/hermes/chat', component: Chat },
] })
;(window as any).chatImportFixture = { route: () => router.currentRoute.value.fullPath }
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { display: 'flex', height: '100vh', width: '100vw' } }, [h(RouterView)]),
  }) }) }),
})
app.use(createPinia()); app.use(await i18nReady); app.use(router)
await router.push('/'); await router.isReady(); app.mount('#app')
