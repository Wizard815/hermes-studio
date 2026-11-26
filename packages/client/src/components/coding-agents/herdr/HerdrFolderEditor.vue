<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NInput, NModal, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import WorkspacePickerModal from '@/components/common/WorkspacePickerModal.vue'
import { colorClass, FOLDER_COLOR_NAMES, isWithin, type SidebarFolder } from './space-folders'

/**
 * Edit a space folder (or make one), as herdr-space-folders' dialog does: its
 * name, the folder new spaces in it start in (Choose… browses the Studio
 * server's folders), the rules it collects spaces with, and its color. The
 * rules follow the start folder until they are given their own, and the name
 * follows the start folder's last part while it is still the default.
 */
const props = defineProps<{
  /** The folder edited; null makes a new one. */
  folder: SidebarFolder | null
  folders: SidebarFolder[]
  /** A new folder's parent ('' = top level). */
  parentId?: string
  home: string
}>()
const emit = defineEmits<{
  save: [value: { name: string; parentId: string; start: string; rules: string; color: string }]
  cancel: []
}>()

const { t } = useI18n()
const name = ref(props.folder?.name || t('spaceFolders.newFolder'))
const parentId = ref(props.folder?.parentId ?? props.parentId ?? '')
const start = ref(props.folder?.start || '')
const rules = ref(props.folder?.rules || '')
const color = ref(props.folder?.color || '')
const picking = ref(false)
const nameInput = ref<InstanceType<typeof NInput> | null>(null)

// The rules follow the start folder until they are given their own (an empty rule list means "the start folder").
let rulesFollow = !rules.value || rules.value === start.value
const lastPart = (path: string) => {
  const part = path.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  return part === '~' ? '' : part
}
const defaultName = t('spaceFolders.newFolder')
let nameFollows = !props.folder || name.value === defaultName || name.value === lastPart(start.value)
watch(start, value => {
  if (rulesFollow) rules.value = ''
  const part = lastPart(value)
  if (nameFollows && part) name.value = part.slice(0, 40)
})
function onRules(value: string) {
  rules.value = value
  rulesFollow = !value || value === start.value
}
function onName(value: string) {
  name.value = value
  nameFollows = !value || value === defaultName || value === lastPart(start.value)
}

/** Folders it can go in: not itself or its own subfolders. */
const parentOptions = computed(() => [
  { label: t('spaceFolders.topLevel'), value: '' },
  ...props.folders
    .filter(folder => !props.folder || !isWithin(props.folders, folder.id, props.folder.id))
    .map(folder => ({ label: `${'  '.repeat(folder.depth)}${folder.name}`, value: folder.id })),
])

/** The server's folder picker gives absolute paths; home is written "~" as herdr-space-folders does. */
function picked(path: string) {
  picking.value = false
  start.value = props.home && (path === props.home || path.startsWith(`${props.home}/`)) ? `~${path.slice(props.home.length)}` : path
}

const valid = computed(() => !!name.value.trim() && name.value.trim().length <= 40)
function save() {
  if (!valid.value) return
  emit('save', { name: name.value.trim(), parentId: parentId.value, start: start.value.trim(), rules: rulesFollow ? '' : rules.value.trim(), color: color.value })
}

onMounted(() => { void nextTick(() => { nameInput.value?.focus(); nameInput.value?.select() }) })
</script>

<template>
  <NModal
    :show="true"
    preset="card"
    class="sf-editor"
    :title="folder ? t('spaceFolders.editTitle') : t('spaceFolders.newTitle')"
    :bordered="false"
    style="width: min(460px, calc(100vw - 32px))"
    data-testid="space-folder-editor"
    @update:show="value => { if (!value) emit('cancel') }"
    @keydown.enter.exact.prevent="save"
  >
    <div class="sf-editor-body">
      <label class="sf-editor-field">
        <span>{{ t('spaceFolders.name') }}</span>
        <NInput ref="nameInput" :value="name" maxlength="40" data-testid="space-folder-name" @update:value="onName" />
      </label>
      <label class="sf-editor-field">
        <span>{{ t('spaceFolders.parent') }}</span>
        <NSelect v-model:value="parentId" :options="parentOptions" data-testid="space-folder-parent" />
      </label>
      <div class="sf-editor-field">
        <span>{{ t('spaceFolders.start') }}</span>
        <div class="sf-editor-row">
          <NInput v-model:value="start" placeholder="~/code/owner/repo" data-testid="space-folder-start" />
          <NButton data-testid="space-folder-choose" @click="picking = true">{{ t('spaceFolders.choose') }}</NButton>
        </div>
        <small>{{ t('spaceFolders.startHint') }}</small>
      </div>
      <label class="sf-editor-field">
        <span>{{ t('spaceFolders.rules') }}</span>
        <NInput :value="rulesFollow ? start : rules" placeholder="wbso-ai, ~/code/client-*" data-testid="space-folder-rules" @update:value="onRules" />
        <small>{{ t('spaceFolders.rulesHint') }}</small>
      </label>
      <div class="sf-editor-field">
        <span>{{ t('spaceFolders.color') }}</span>
        <div class="sf-swatches" role="radiogroup" :aria-label="t('spaceFolders.color')">
          <button
            v-for="item in ['', ...FOLDER_COLOR_NAMES]"
            :key="item || 'none'"
            type="button"
            role="radio"
            class="sf-swatch"
            :class="[colorClass(item), { active: color === item }]"
            :aria-checked="color === item"
            :aria-label="t(`spaceFolders.colors.${item || 'none'}`)"
            :title="t(`spaceFolders.colors.${item || 'none'}`)"
            :data-testid="`space-folder-color-${item || 'none'}`"
            @click="color = item"
          />
        </div>
      </div>
    </div>
    <template #footer>
      <div class="sf-editor-actions">
        <NButton data-testid="space-folder-cancel" @click="emit('cancel')">{{ t('spaceFolders.cancel') }}</NButton>
        <NButton type="primary" :disabled="!valid" data-testid="space-folder-save" @click="save">{{ t('spaceFolders.save') }}</NButton>
      </div>
    </template>
  </NModal>
  <WorkspacePickerModal v-if="picking" :title="t('spaceFolders.start')" :current="start.startsWith('~') ? `${home}${start.slice(1)}` : start" @select="picked" @cancel="picking = false" />
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './space-colors' as colors;

@include colors.palette;

.sf-editor-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sf-editor-field {
  display: flex;
  flex-direction: column;
  gap: 6px;

  > span {
    font-size: 12px;
    font-weight: 500;
    color: $text-secondary;
  }

  small {
    font-size: 11.5px;
    color: $text-muted;
  }
}

.sf-editor-row {
  display: flex;
  gap: 8px;
}

.sf-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.sf-swatches {
  display: flex;
  gap: 8px;
}

.sf-swatch {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 999px;
  cursor: pointer;

  &.active {
    border-color: $text-primary;
  }
}
</style>
