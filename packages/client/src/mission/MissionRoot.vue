<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme } from 'naive-ui'
import { useTheme } from '@/composables/useTheme'
import { getThemeOverrides } from '@/styles/theme'
import { getApiKey } from '@/api/client'
import MissionLogin from './MissionLogin.vue'
import MissionApp from './MissionApp.vue'

const { isDark, isComic, customization, hasCustomBackground, syncThemeFromServer } = useTheme()
const themeOverrides = computed(() => getThemeOverrides(isDark.value, isComic.value, customization.value, hasCustomBackground.value))
const signedIn = ref(!!getApiKey())

onMounted(() => {
  if (signedIn.value) void syncThemeFromServer().catch(() => undefined)
})

function onSignedIn() {
  signedIn.value = true
  void syncThemeFromServer().catch(() => undefined)
}
</script>

<template>
  <NConfigProvider :theme="isDark ? darkTheme : null" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <MissionApp v-if="signedIn" @signed-out="signedIn = false" />
        <MissionLogin v-else @signed-in="onSignedIn" />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
