import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import ProjectsList from '../../../packages/client/src/components/hermes/chat/ProjectsList.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// The chat list's Projects view is real; the spec mocks the API and records what it opens.
const opened = ref<string[]>([])
;(window as any).projectsFixture = { opened: () => opened.value, back: 0 }
const app = createApp({
  render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, {
    default: () => h('aside', { style: { width: '300px', height: '100vh' } }, [h(ProjectsList, {
      activeSessionId: opened.value.at(-1) ?? null,
      onOpen: (id: string) => { opened.value = [...opened.value, id] },
      onBack: () => { (window as any).projectsFixture.back += 1 },
    })]),
  }) }),
})
app.use(createPinia()); app.use(await i18nReady)
app.mount('#app')
