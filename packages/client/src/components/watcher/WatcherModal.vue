<script setup lang="ts">
import { NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useWatcher } from '@/composables/useWatcher'
import WatcherAlertList from './WatcherAlertList.vue'

/** The bell's list as a dialog, for phone menus (docs/watcher.md). Mounted once in App.vue. */
const { t } = useI18n()
const watcher = useWatcher()
</script>

<template>
  <NModal
    v-model:show="watcher.dialogOpen.value"
    preset="card"
    :title="t('watcher.title')"
    :style="{ width: 'min(460px, calc(100vw - 16px))' }"
    data-testid="watcher-modal"
  >
    <WatcherAlertList in-dialog @navigate="watcher.dialogOpen.value = false" />
  </NModal>
</template>
