import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import AndroidDevicesView from '../../../packages/client/src/views/hermes/AndroidDevicesView.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// The Android view is real; the spec mocks the API and speaks Socket.IO on `/android`.
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
;(window as any).__route = () => router.currentRoute.value.fullPath
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { display: 'flex', height: '100vh', width: '100vw' } }, [h(AndroidDevicesView)]),
  }) }) }),
})
app.use(createPinia()); app.use(router); app.use(await i18nReady)
app.mount('#app')
