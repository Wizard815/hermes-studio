import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider, darkTheme } from 'naive-ui'
import LlmWikiConnectionPanel from '../../../packages/client/src/components/hermes/connections/LlmWikiConnectionPanel.vue'
import McpCatalogPanel from '../../../packages/client/src/components/hermes/mcp/McpCatalogPanel.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// Connections → LLM wiki and the MCP page's catalog card are real; the spec mocks the API.
const params = new URLSearchParams(location.search)
const view = params.get('view') || 'connections'
const dark = params.get('theme') === 'dark'
if (dark) document.documentElement.setAttribute('data-theme', 'dark')
const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: '/', component: { render: () => null } },
  { name: 'hermes.mcp', path: '/hermes/mcp', component: { render: () => null } },
] })
;(window as any).llmWikiFixture = { route: () => router.currentRoute.value.fullPath }
const app = createApp({
  render: () => h(NConfigProvider, { theme: dark ? darkTheme : null }, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => view === 'mcp'
      ? h('main', { style: { padding: '16px', maxWidth: '1100px' } }, [h(McpCatalogPanel)])
      : h('main', { style: { display: 'flex', height: '100vh', width: '100vw' } }, [h(LlmWikiConnectionPanel)]),
  }) }) }),
})
app.use(createPinia()); app.use(await i18nReady); app.use(router)
await router.isReady(); app.mount('#app')
