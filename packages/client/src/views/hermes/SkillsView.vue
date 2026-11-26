<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { NBadge, NButton, NDrawer, NDrawerContent, NInput, NPopover } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import SkillList from '@/components/hermes/skills/SkillList.vue'
import SkillDetail from '@/components/hermes/skills/SkillDetail.vue'
import SkillImportModal from '@/components/hermes/skills/SkillImportModal.vue'
import SkillExternalDirsModal from '@/components/hermes/skills/SkillExternalDirsModal.vue'
import SkillSourceLegend from '@/components/hermes/skills/SkillSourceLegend.vue'
import PendingWriteApprovals from '@/components/hermes/skills/PendingWriteApprovals.vue'
import CuratorCard from '@/components/hermes/skills/CuratorCard.vue'
import SkillsHubPanel from '@/components/hermes/skills/SkillsHubPanel.vue'
import SkillLockToggle from '@/components/hermes/skills/SkillLockToggle.vue'
import UiSkillsBundleCard from '@/components/hermes/skills/UiSkillsBundleCard.vue'
import { listHermesSkills } from '@/api/hermes/agent-memory'
import { isStoredSuperAdmin } from '@/api/client'
import { deleteSkillApi, importSkill, fetchSkills, type SkillCategory, type SkillSource, type SkillInfo, type SkillTarget } from '@/api/hermes/skills'
import { fetchPendingWrites } from '@/api/hermes/write-gate'
import { useProfilesStore } from '@/stores/hermes/profiles'

type SourceFilter = SkillSource | 'modified'

const props = withDefaults(defineProps<{
  target?: SkillTarget
  embedded?: boolean
}>(), {
  target: 'hermes',
  embedded: false,
})

const { t } = useI18n()
const profilesStore = useProfilesStore()
const categories = ref<SkillCategory[]>([])
const archived = ref<SkillInfo[]>([])
const loading = ref(true)
const selectedCategory = ref('')
const selectedSkill = ref('')
const searchQuery = ref('')
const showSidebar = ref(true)
const sourceFilter = ref<SourceFilter | null>(null)
const skillTarget = computed(() => props.target)
const showImportModal = ref(false)
const showExternalDirsModal = ref(false)
const showWriteApprovalDrawer = ref(false)
const pendingWriteCount = ref(0)
const writeApprovalSupported = ref(true)
let mobileQuery: MediaQueryList | null = null
const showHubDrawer = ref(false)
/** Skill locks (agent/curator may not change them) live in Hermes; read through its API. */
const skillLocks = ref<Map<string, boolean>>(new Map())

const selectedSkillData = computed(() => {
  if (!selectedCategory.value || !selectedSkill.value) return null
  if (selectedCategory.value === '.archive') {
    return archived.value.find(s => s.name === selectedSkill.value) ?? null
  }
  const cat = categories.value.find(c => c.name === selectedCategory.value)
  return cat?.skills.find(s => s.name === selectedSkill.value) ?? null
})

const isHermesTarget = computed(() => skillTarget.value === 'hermes')
// Hub, curator and locks go through Hermes's own API (super administrators only).
const hermesAgentTools = computed(() => isHermesTarget.value && isStoredSuperAdmin())
const selectedLockName = computed(() => {
  const candidates = [selectedSkillData.value?.name, selectedSkill.value].filter(Boolean) as string[]
  return candidates.find(name => skillLocks.value.has(name)) ?? null
})
const canManageTarget = computed(() => isHermesTarget.value || skillTarget.value === 'dsh' || (skillTarget.value === 'cursor' || skillTarget.value === 'antigravity'))
const selectedSkillReadonly = computed(() => {
  if (!selectedSkillData.value) return true
  if (selectedSkillData.value.readonly) return true
  if (selectedCategory.value === '.archive') return true
  return (selectedSkillData.value.source || 'local') !== 'local'
})

function handleMobileChange(e: MediaQueryListEvent | MediaQueryList) {
  showSidebar.value = !e.matches
}

onMounted(() => {
  mobileQuery = window.matchMedia('(max-width: 768px)')
  handleMobileChange(mobileQuery)
  mobileQuery.addEventListener('change', handleMobileChange)
  loadSkills()
  loadPendingWriteCount()
})

onUnmounted(() => {
  mobileQuery?.removeEventListener('change', handleMobileChange)
})

watch(() => props.target, () => {
  selectedCategory.value = ''
  selectedSkill.value = ''
  loadSkills()
})

async function loadSkills() {
  loading.value = true
  try {
    if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
      await profilesStore.fetchProfiles()
    }
    const data = await fetchSkills(undefined, skillTarget.value)
    categories.value = data.categories
    archived.value = data.archived
    ensureSelectedSkill()
    void loadSkillLocks()
  } catch (err: any) {
    console.error('Failed to load skills:', err)
  } finally {
    loading.value = false
  }
}

async function loadSkillLocks() {
  if (!hermesAgentTools.value) return
  try {
    const rows = await listHermesSkills()
    skillLocks.value = new Map(rows.map(row => [row.name, !!row.locked]))
  } catch (err) {
    console.error('Failed to load skill locks:', err)
  }
}

function handleLockToggled(name: string, locked: boolean) {
  skillLocks.value = new Map(skillLocks.value).set(name, locked)
}

async function loadPendingWriteCount() {
  if (!isHermesTarget.value) return
  try {
    const data = await fetchPendingWrites()
    writeApprovalSupported.value = data.supported !== false
    pendingWriteCount.value = writeApprovalSupported.value ? data.records?.length || 0 : 0
  } catch (err) {
    console.error('Failed to load pending write approvals:', err)
  }
}

function ensureSelectedSkill() {
  const currentCategory = categories.value.find(c => c.name === selectedCategory.value)
  if (currentCategory?.skills.some(s => s.name === selectedSkill.value)) return

  const firstCategory = categories.value.find(c => c.skills.length > 0)
  const firstSkill = firstCategory?.skills[0]
  selectedCategory.value = firstCategory?.name || ''
  selectedSkill.value = firstSkill?.name || ''
}

function handleSelect(category: string, skill: string) {
  if (selectedCategory.value === category && selectedSkill.value === skill) {
    return
  }
  selectedCategory.value = category
  selectedSkill.value = skill
  if (window.innerWidth <= 768) {
    showSidebar.value = false
  }
}

function handleSkillDeleted(category: string, skillName: string) {
  if (selectedCategory.value === category && selectedSkill.value === skillName) {
    selectedCategory.value = ''
    selectedSkill.value = ''
  }
  loadSkills()
}

function handleImported() {
  showImportModal.value = false
  loadSkills()
}

function handleExternalDirsSaved() {
  showExternalDirsModal.value = false
  loadSkills()
}

function handlePinToggled(name: string, pinned: boolean) {
  // Update local state so the pin icon updates immediately
  if (selectedCategory.value === '.archive') {
    const skill = archived.value.find(s => s.name === name)
    if (skill) skill.pinned = pinned
  } else {
    const cat = categories.value.find(c => c.name === selectedCategory.value)
    const skill = cat?.skills.find(s => s.name === name)
    if (skill) skill.pinned = pinned
  }
}

function handleSkillSaved() {
  loadSkills()
}
</script>

<template>
  <PageLoading :show="loading && categories.length === 0" class="skills-view" :class="{ embedded }">
    <PageHeader>
    <header class="page-header">
      <div class="skills-header-heading">
        <h2 class="header-title">{{ t('skills.title') }}</h2>
        <button v-if="!showSidebar" class="sidebar-toggle" @click="showSidebar = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <SkillSourceLegend v-model="sourceFilter" :show-hub="isHermesTarget" />
      </div>
      <div class="header-actions">
        <NButton
          v-if="isHermesTarget && writeApprovalSupported"
          class="header-action-btn"
          size="small"
          :title="t('skills.writeApprovalTitle')"
          @click="showWriteApprovalDrawer = true"
        >
          <template #icon>
            <NBadge :value="pendingWriteCount" :max="99" :show="pendingWriteCount > 0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </NBadge>
          </template>
          <span class="header-action-label">
            {{ t('skills.writeApprovalButton', { count: pendingWriteCount }) }}
          </span>
        </NButton>
        <NPopover v-if="hermesAgentTools" trigger="click" placement="bottom-end">
          <template #trigger>
            <NButton class="header-action-btn" size="small" :title="t('hermesMemory.curator')">
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 3l1.9 5.8L20 10l-5 3.6L16.5 20 12 16.5 7.5 20 9 13.6 4 10l6.1-1.2z" />
                </svg>
              </template>
              <span class="header-action-label">{{ t('hermesMemory.curator') }}</span>
            </NButton>
          </template>
          <CuratorCard @ran="loadSkills" />
        </NPopover>
        <NButton
          v-if="hermesAgentTools"
          class="header-action-btn"
          size="small"
          :title="t('hermesMemory.hub')"
          @click="showHubDrawer = true"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </template>
          <span class="header-action-label">{{ t('hermesMemory.hub') }}</span>
        </NButton>
        <NButton
          v-if="canManageTarget"
          class="header-action-btn"
          size="small"
          :title="t('skills.import')"
          @click="showImportModal = true"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </template>
          <span class="header-action-label">{{ t('skills.import') }}</span>
        </NButton>
        <NButton
          v-if="isHermesTarget"
          class="header-action-btn"
          size="small"
          :title="t('skills.externalDirs.manage')"
          @click="showExternalDirsModal = true"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </template>
          <span class="header-action-label">{{ t('skills.externalDirs.manage') }}</span>
        </NButton>
        <NInput
          v-model:value="searchQuery"
          :placeholder="t('skills.searchPlaceholder')"
          size="small"
          clearable
          style="width: 130px"
        />
      </div>
    </header>
    </PageHeader>

    <SkillImportModal
      v-if="showImportModal"
      :allow-category="skillTarget !== 'dsh'"
      :import-handler="!isHermesTarget ? (files, category) => importSkill(files, category, skillTarget) : undefined"
      @close="showImportModal = false"
      @saved="handleImported"
    />
    <SkillExternalDirsModal v-if="showExternalDirsModal"
      @close="showExternalDirsModal = false" @saved="handleExternalDirsSaved" />
    <NDrawer
      v-model:show="showWriteApprovalDrawer"
      width="var(--studio-drawer-width)"
      placement="right"
      class="write-approval-drawer"
    >
      <NDrawerContent :title="t('skills.writeApprovalTitle')" closable>
        <PendingWriteApprovals
          v-if="showWriteApprovalDrawer"
          @count-change="(count) => pendingWriteCount = count"
        />
      </NDrawerContent>
    </NDrawer>

    <NDrawer v-if="hermesAgentTools" v-model:show="showHubDrawer" width="var(--studio-drawer-width)" placement="right">
      <NDrawerContent :title="t('hermesMemory.hubTitle')" closable>
        <SkillsHubPanel v-if="showHubDrawer" @changed="loadSkills" />
      </NDrawerContent>
    </NDrawer>

    <div class="skills-content">
      <UiSkillsBundleCard :target="skillTarget" :profile="profilesStore.activeProfileName" />
      <div v-if="loading && categories.length === 0" class="skills-loading"></div>
      <div v-else class="skills-layout">
          <div class="mobile-backdrop" :class="{ active: showSidebar }" @click="showSidebar = false" />
          <div v-if="showSidebar" class="skills-sidebar">
            <SkillList
              :categories="categories"
              :archived="archived"
              :selected-skill="selectedCategory && selectedSkill ? `${selectedCategory}/${selectedSkill}` : null"
              :search-query="searchQuery"
              :source-filter="sourceFilter"
              :readonly="!canManageTarget"
              :toggleable="isHermesTarget"
              :delete-handler="!isHermesTarget ? (category, name) => deleteSkillApi(category, name, skillTarget) : undefined"
              @select="handleSelect"
              @deleted="handleSkillDeleted"
            />
          </div>
          <div class="skills-main">
            <SkillDetail
              v-if="selectedCategory && selectedSkill"
              :category="selectedCategory"
              :skill="selectedSkill"
              :skill-name="selectedSkillData?.name || selectedSkill"
              :patch-count="selectedSkillData?.patchCount"
              :use-count="selectedSkillData?.useCount"
              :view-count="selectedSkillData?.viewCount"
              :pinned="selectedSkillData?.pinned"
              :target="skillTarget"
              :readonly="selectedSkillReadonly"
              :can-pin="isHermesTarget"
              @pin-toggled="handlePinToggled"
              @saved="handleSkillSaved"
            >
              <template v-if="hermesAgentTools && selectedLockName" #actions>
                <SkillLockToggle :name="selectedLockName" :locked="!!skillLocks.get(selectedLockName)" @toggled="handleLockToggled" />
              </template>
            </SkillDetail>
            <div v-else class="empty-detail">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.2">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
              <span>{{ t('skills.noSkills') }}</span>
            </div>
          </div>
        </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/skills-manager' as skills-manager;

@include skills-manager.layout;

.header-actions {
  display: flex;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
}

// The UI skills card sits above the list; the list and detail take the rest.
.skills-content { display: flex; flex-direction: column; }
.skills-layout { flex: 1; min-height: 0; height: auto; }

.skills-view.embedded {
  height: 100%;
  min-height: 0;
  padding: 0;
  background: transparent;
}

@media (max-width: $breakpoint-mobile) {
  .header-action-label {
    display: none;
  }

  .header-action-btn {
    width: 30px;
    padding: 0;

    :deep(.n-button__content) {
      justify-content: center;
    }

    :deep(.n-button__icon) {
      margin: 0;
    }
  }
}

.search-input {
  width: 100px;

  @media (max-width: $breakpoint-mobile) {
    width: 100%;
  }
}

</style>
