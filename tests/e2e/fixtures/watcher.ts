import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import WatcherBell from '../../../packages/client/src/components/watcher/WatcherBell.vue'
import WatcherModal from '../../../packages/client/src/components/watcher/WatcherModal.vue'
import WatcherSettings from '../../../packages/client/src/components/hermes/settings/WatcherSettings.vue'
import CleanRoomSettings from '../../../packages/client/src/components/hermes/settings/CleanRoomSettings.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// The watcher's bell (top-bar and phone-menu forms), Settings → Watcher and Settings → Clean rooms; the spec mocks the API.
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
;(window as any).__route = () => router.currentRoute.value.fullPath
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { padding: '16px', maxWidth: '960px' } }, [
      h('header', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, [h(WatcherBell), h('div', { style: { width: '200px' } }, [h(WatcherBell, { variant: 'menu' })])]),
      h(WatcherModal),
      h(WatcherSettings),
      h(CleanRoomSettings),
    ]),
  }) }) }),
})
app.use(createPinia()); app.use(router); app.use(await i18nReady)
app.mount('#app')
