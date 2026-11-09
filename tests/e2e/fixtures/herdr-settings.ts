import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory, RouterView } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import CodingAgentConfigView from '../../../packages/client/src/views/hermes/CodingAgentConfigView.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// herdr's settings as the agents page shows them (/studio/agents/herdr/settings); the API is mocked by the spec.
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ name: 'codingAgent.config', path: '/studio/agents/:agentId/:section', component: CodingAgentConfigView }],
})
await router.push('/studio/agents/herdr/settings')
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw' } }, [h(RouterView)]),
  }) }) }),
})
app.use(createPinia()); app.use(await i18nReady); app.use(router)
await router.isReady(); app.mount('#app')
