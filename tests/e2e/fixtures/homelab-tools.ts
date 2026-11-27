import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import McpDirectoryPanel from '../../../packages/client/src/components/hermes/mcp/McpDirectoryPanel.vue'
import RepoPackButton from '../../../packages/client/src/components/hermes/chat/RepoPackButton.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// The MCP page's Directory tab and the composer's Add a repo button; the spec mocks the API.
const view = new URLSearchParams(location.search).get('view') || 'directory'
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/hermes/chat', name: 'hermes.chat', component: { render: () => null } },
    { path: '/:any(.*)*', component: { render: () => null } },
  ],
})
const attached = ref<string[]>([])
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { padding: '16px', maxWidth: '1100px' } }, [
      view === 'repo-pack'
        ? h(RepoPackButton, { onAttach: (file: File) => { attached.value = [...attached.value, `${file.name} ${file.type} ${file.size}`] } })
        : h(McpDirectoryPanel),
      h('pre', { 'data-testid': 'route' }, router.currentRoute.value.fullPath),
      h('pre', { 'data-testid': 'attached' }, attached.value.join('\n')),
    ]),
  }) }) }),
})
app.use(createPinia()); app.use(router); app.use(await i18nReady)
app.mount('#app')
