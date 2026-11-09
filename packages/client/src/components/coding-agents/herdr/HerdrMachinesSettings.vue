<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NInput, NPopconfirm, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { addHerdrMachine, changeHerdrMachine, fetchHerdrMachines, removeHerdrMachine, type HerdrMachine } from '@/api/coding-agents/herdr'

/**
 * herdr remote: saved SSH machines (herdr's `machine` commands). Their spaces
 * and agents show up in herdr here, so their agents get Studio chats too.
 */
const { t } = useI18n()
const toast = useMessage()
const machines = ref<HerdrMachine[]>([])
const form = ref({ target: '', label: '', session: '' })
const adding = ref(false)
const checking = ref(false)
const busy = ref<Record<string, boolean>>({})

async function load(withStatus = false) {
  try { machines.value = (await fetchHerdrMachines(withStatus)).machines } catch (err: any) { toast.error(err?.message || String(err)) }
}

async function check() {
  checking.value = true
  try { await load(true) } finally { checking.value = false }
}

async function add() {
  if (!form.value.target.trim()) return
  adding.value = true
  try {
    const result = await addHerdrMachine({
      target: form.value.target.trim(),
      ...(form.value.label.trim() ? { label: form.value.label.trim() } : {}),
      ...(form.value.session.trim() ? { session: form.value.session.trim() } : {}),
    })
    machines.value = result.machines
    form.value = { target: '', label: '', session: '' }
    toast.success(t('herdr.settings.machineAdded'))
  } catch (err: any) {
    toast.error(err?.message || String(err), { duration: 8000 })
  } finally {
    adding.value = false
  }
}

async function run(machine: HerdrMachine, action: () => Promise<{ machines: HerdrMachine[] }>) {
  busy.value = { ...busy.value, [machine.id]: true }
  try { machines.value = (await action()).machines } catch (err: any) { toast.error(err?.message || String(err)) } finally {
    busy.value = { ...busy.value, [machine.id]: false }
  }
}

function statusClass(machine: HerdrMachine): string {
  if (!machine.status) return ''
  return machine.status === 'reachable' ? 'is-good' : machine.status === 'disabled' ? '' : 'is-bad'
}

onMounted(() => { void load() })
</script>

<template>
  <section class="herdr-machines" data-testid="herdr-machines">
    <header class="herdr-machines-head">
      <h4>{{ t('herdr.settings.machinesTitle') }}</h4>
      <NButton size="tiny" :loading="checking" :disabled="!machines.length" data-testid="herdr-machines-check" @click="check">{{ t('herdr.settings.machineCheck') }}</NButton>
    </header>
    <p class="herdr-machines-hint">{{ t('herdr.settings.machinesHint') }}</p>

    <p v-if="!machines.length" class="herdr-machines-empty">{{ t('herdr.settings.machinesNone') }}</p>
    <ul v-else class="herdr-machines-list">
      <li v-for="machine in machines" :key="machine.id" class="herdr-machine" data-testid="herdr-machine">
        <div class="herdr-machine-main">
          <strong>{{ machine.label || machine.target }}</strong>
          <code>{{ machine.target }}<template v-if="machine.session && machine.session !== 'default'"> · {{ machine.session }}</template></code>
          <span v-if="machine.status" class="herdr-machine-status" :class="statusClass(machine)" :title="machine.error">{{ machine.status }}</span>
        </div>
        <label class="herdr-machine-toggle">
          <span>{{ t('herdr.settings.machineEnabled') }}</span>
          <NSwitch size="small" :value="machine.enabled" :loading="busy[machine.id]" @update:value="value => run(machine, () => changeHerdrMachine(machine.id, { enabled: value }))" />
        </label>
        <NPopconfirm @positive-click="run(machine, () => removeHerdrMachine(machine.id))">
          <template #trigger>
            <NButton size="tiny" type="error" secondary :disabled="busy[machine.id]">{{ t('herdr.settings.machineRemove') }}</NButton>
          </template>
          {{ t('herdr.settings.machineRemoveConfirm', { name: machine.label || machine.target }) }}
        </NPopconfirm>
      </li>
    </ul>

    <div class="herdr-machines-form">
      <NInput v-model:value="form.target" size="small" :placeholder="t('herdr.settings.machineTarget')" data-testid="herdr-machine-target" @keydown.enter="add" />
      <NInput v-model:value="form.label" size="small" :placeholder="t('herdr.settings.machineLabel')" />
      <NInput v-model:value="form.session" size="small" :placeholder="t('herdr.settings.machineSession')" />
      <NButton size="small" type="primary" :loading="adding" :disabled="!form.target.trim()" data-testid="herdr-machine-add" @click="add">{{ t('herdr.settings.machineAdd') }}</NButton>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.herdr-machines {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: var(--border-width, 1px) solid $border-light;
}

.herdr-machines-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  h4 {
    margin: 0;
    font-size: 14px;
  }
}

.herdr-machines-hint,
.herdr-machines-empty {
  margin: 0;
  font-size: 12px;
  color: $text-muted;
}

.herdr-machines-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.herdr-machine {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
}

.herdr-machine-main {
  display: flex;
  flex: 1 1 220px;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;

  code {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    color: $text-secondary;
  }
}

.herdr-machine-status {
  font-size: 11.5px;
  color: $text-muted;

  &.is-good {
    color: $success;
  }

  &.is-bad {
    color: $error;
  }
}

.herdr-machine-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: $text-secondary;
}

.herdr-machines-form {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 8px;
}

@media (max-width: 640px) {
  .herdr-machines-form {
    grid-template-columns: 1fr;
  }
}
</style>
