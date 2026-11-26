import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import SkillsView from '../../../packages/client/src/views/hermes/SkillsView.vue'
import McpCatalogPanel from '../../../packages/client/src/components/hermes/mcp/McpCatalogPanel.vue'
import UiSkillsSettings from '../../../packages/client/src/components/hermes/settings/UiSkillsSettings.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// The Skills page with the bundled UI skills, Settings' switch and the MCP catalog's Paper card; the spec mocks the API.
const view = new URLSearchParams(location.search).get('view') || 'skills'
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => view === 'mcp'
      ? h('main', { style: { padding: '16px', maxWidth: '1100px' } }, [h(McpCatalogPanel)])
      : view === 'settings'
        ? h('main', { style: { padding: '16px', maxWidth: '900px' } }, [h(UiSkillsSettings)])
        : h('main', { style: { height: '100vh' } }, [h(SkillsView)]),
  }) }) }),
})
app.use(createPinia()); app.use(router); app.use(await i18nReady)
app.mount('#app')
