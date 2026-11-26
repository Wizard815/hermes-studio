import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import ChatPanel from '../../../packages/client/src/components/hermes/chat/ChatPanel.vue'
import { useChatStore } from '../../../packages/client/src/stores/hermes/chat'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// The real chat panel on a hash router, as Studio Own loads `#/hermes/chat?compose=...`.
// The spec mocks the API; sending is replaced so nothing can leave the page.
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { name: 'hermes.chat', path: '/hermes/chat', component: ChatPanel },
    { name: 'hermes.session', path: '/hermes/session/:sessionId', component: ChatPanel },
  ],
})
const pinia = createPinia()
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { display: 'flex', height: '100vh', width: '100vw' } }, [h(RouterView)]),
  }) }) }),
})
app.use(pinia); app.use(await i18nReady); app.use(router)
const chat = useChatStore(pinia)
const sent: string[] = []
chat.sendMessage = async (text: string) => { sent.push(text) }
;(window as any).composeLinkFixture = { sent, route: () => router.currentRoute.value.fullPath }
await router.isReady(); app.mount('#app')
// What ChatView does once the sidebar's sessions arrived (none here).
chat.sessionsLoaded = true
