import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import HerdrSpacesPanel from '../../../packages/client/src/components/coding-agents/herdr/HerdrSpacesPanel.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// The chat page's herdr-mode sidebar is real; the spec mocks the API and swallows sockets.
const opened: string[] = []
;(window as any).herdrSpacesFixture = { opened }
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, {
    default: () => h('aside', { style: { display: 'flex', flexDirection: 'column', height: '100vh', width: '300px' } }, [
      h(HerdrSpacesPanel, { activeSessionId: 'herdr-aaa', onOpenChat: (id: string) => opened.push(id) }),
    ]),
  }) }),
})
app.use(createPinia()); app.use(await i18nReady)
app.mount('#app')
