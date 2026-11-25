import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import HermesToolSearchSettings from '../../../packages/client/src/components/hermes/settings/HermesToolSearchSettings.vue'
import ToolLoadBanner from '../../../packages/client/src/components/hermes/tool-load/ToolLoadBanner.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// Settings → Tools (tool search, threshold) and a Hermes chat's tool-load notice; the API is mocked by the spec.
const Blank = { render: () => null }
const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: '/', component: Blank },
  { path: '/hermes/mcp', name: 'hermes.mcp', component: Blank },
  { path: '/hermes/config/settings', name: 'hermes.configSettings', component: Blank },
] })
;(window as any).__route = () => router.currentRoute.value.fullPath
const pinia = createPinia()
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { padding: '16px', maxWidth: '900px' } }, [h(ToolLoadBanner, { sessionId: 'chat-1' }), h(HermesToolSearchSettings)]),
  }) }) }),
})
app.use(pinia); app.use(router); app.use(await i18nReady)
await router.push('/')
app.mount('#app')
