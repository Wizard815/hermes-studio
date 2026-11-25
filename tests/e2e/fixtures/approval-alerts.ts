import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import ApprovalAlertsSettings from '../../../packages/client/src/components/hermes/settings/ApprovalAlertsSettings.vue'
import AndroidAppSettings from '../../../packages/client/src/components/hermes/settings/AndroidAppSettings.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// Settings → Watcher → Where approvals reach you, and Settings → Android app; the spec mocks the API (and the app's bridge).
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
;(window as any).__route = () => router.currentRoute.value.fullPath
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { padding: '16px', maxWidth: '960px' } }, [h(ApprovalAlertsSettings), h(AndroidAppSettings)]),
  }) }) }),
})
app.use(createPinia()); app.use(router); app.use(await i18nReady)
app.mount('#app')
