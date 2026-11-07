<script setup lang="ts">
import { ref, watch } from 'vue'
import { NButton, NInput, NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { SpaceFolder } from '@/api/coding-agents/herdr'
import { FOLDER_PALETTE, newFolder } from './useMission'

/** Create or edit a space folder: name, color, start folder and collect rules. */
const props = defineProps<{ show: boolean; folder: SpaceFolder | null }>()
const emit = defineEmits<{ 'update:show': [value: boolean]; save: [folder: SpaceFolder]; remove: [folder: SpaceFolder] }>()
const { t } = useI18n()
const draft = ref<SpaceFolder>(newFolder())
const isNew = ref(true)

watch(() => [props.show, props.folder] as const, ([show, folder]) => {
  if (!show) return
  isNew.value = !folder
  draft.value = folder ? { ...folder } : newFolder()
}, { immediate: true })

/** While the name is still the default, it follows the start folder's last part. */
function onStartInput(value: string) {
  const lastPart = (draft.value.start || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  if (!draft.value.name || draft.value.name === 'New folder' || draft.value.name === lastPart) {
    draft.value.name = value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || draft.value.name
  }
  if (!draft.value.rules.trim() || draft.value.rules === draft.value.start) draft.value.rules = value
  draft.value.start = value
}

function save() {
  emit('save', { ...draft.value, name: draft.value.name.trim() || 'New folder' })
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="isNew ? t('mission.newFolder') : t('mission.editFolder')"
    :style="{ width: 'min(460px, calc(100vw - 32px))' }"
    @update:show="value => emit('update:show', value)"
  >
    <form class="folder-form" @submit.prevent="save">
      <label>
        <span>{{ t('mission.folderName') }}</span>
        <NInput v-model:value="draft.name" data-testid="mission-folder-name" />
      </label>
      <div class="folder-colors" role="radiogroup" :aria-label="t('mission.folderColor')">
        <button
          v-for="color in FOLDER_PALETTE"
          :key="color || 'none'"
          type="button"
          class="folder-color"
          :class="{ selected: draft.color === color }"
          :data-color="color || 'none'"
          role="radio"
          :aria-checked="draft.color === color"
          :aria-label="color || t('mission.noColor')"
          @click="draft.color = color"
        />
      </div>
      <label>
        <span>{{ t('mission.folderStart') }}</span>
        <NInput :value="draft.start" placeholder="~/code/project" @update:value="onStartInput" />
      </label>
      <label>
        <span>{{ t('mission.folderRules') }}</span>
        <NInput v-model:value="draft.rules" placeholder="~/code/client-*, wbso-ai" data-testid="mission-folder-rules" />
        <small>{{ t('mission.folderRulesHint') }}</small>
      </label>
      <div class="folder-actions">
        <NButton v-if="!isNew && folder" quaternary type="error" @click="emit('remove', folder); emit('update:show', false)">{{ t('mission.deleteFolder') }}</NButton>
        <span class="folder-spacer" />
        <NButton @click="emit('update:show', false)">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" attr-type="submit" data-testid="mission-folder-save">{{ t('common.save') }}</NButton>
      </div>
    </form>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.folder-form {
  display: flex;
  flex-direction: column;
  gap: 12px;

  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: $text-secondary;
  }

  small {
    color: $text-muted;
  }
}

.folder-colors {
  display: flex;
  gap: 8px;
}

.folder-color {
  width: 20px;
  height: 20px;
  border: 2px solid transparent;
  border-radius: 50%;
  background: $text-muted;
  cursor: pointer;

  &.selected {
    border-color: $text-primary;
  }
}

.folder-color[data-color="teal"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #22a99a;
}

.folder-color[data-color="orange"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #e3814f;
}

.folder-color[data-color="blue"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #5b8def;
}

.folder-color[data-color="violet"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #8b7cf6;
}

.folder-color[data-color="green"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #3fae6a;
}

.folder-color[data-color="pink"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #d9649a;
}

.folder-actions {
  display: flex;
  gap: 8px;
}

.folder-spacer {
  flex: 1 1 auto;
}
</style>
