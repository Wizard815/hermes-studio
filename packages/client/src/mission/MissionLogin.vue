<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { setApiKey } from '@/api/client'

/** Shown on the Mission port, which does not share Studio's browser storage. */
const emit = defineEmits<{ 'signed-in': [] }>()
const { t } = useI18n()
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

async function signIn() {
  busy.value = true
  error.value = ''
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || !body.token) throw new Error(body.error || t('mission.login.failed'))
    setApiKey(body.token)
    emit('signed-in')
  } catch (err: any) {
    error.value = err?.message || String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="mission-login">
    <form class="mission-login-card" data-theme-surface="card" @submit.prevent="signIn">
      <h1>herdr · Mission</h1>
      <p>{{ t('mission.login.intro') }}</p>
      <NInput v-model:value="username" :placeholder="t('mission.login.username')" autocomplete="username" />
      <NInput v-model:value="password" type="password" :placeholder="t('mission.login.password')" autocomplete="current-password" show-password-on="click" />
      <p v-if="error" class="mission-login-error" role="alert">{{ error }}</p>
      <NButton type="primary" attr-type="submit" block :loading="busy">{{ t('mission.login.submit') }}</NButton>
    </form>
  </main>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.mission-login {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 16px;
  box-sizing: border-box;
}

.mission-login-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(360px, 100%);
  padding: 24px;
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 10px);

  h1 {
    margin: 0;
    font-size: 18px;
  }

  p {
    margin: 0;
    font-size: 13px;
    color: $text-secondary;
  }
}

.mission-login-card .mission-login-error {
  color: $error;
}
</style>
