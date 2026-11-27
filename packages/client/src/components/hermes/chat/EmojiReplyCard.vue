<script setup lang="ts">
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { EMOJI_CONTINUE_MESSAGE, EMOJI_EXPLAIN_MESSAGE, emojiReply } from '../../../../../shared/reply-style'

/**
 * Under an emoji-only reply (docs/reply-styles.md): what the emoji means, and
 * Explain (the worded answer) or Continue. Replying in your own words works too.
 */
const props = defineProps<{ content: string; actions?: boolean }>()
const emit = defineEmits<{ send: [text: string] }>()
const { t } = useI18n()
const entry = computed(() => emojiReply(props.content))
</script>

<template>
  <div v-if="entry" class="emoji-reply" data-testid="emoji-reply">
    <span class="emoji-reply__meaning">{{ t(`replyStyle.emoji.${entry.key}`) }}</span>
    <template v-if="actions">
      <NButton size="tiny" secondary @click="emit('send', EMOJI_EXPLAIN_MESSAGE)">{{ t('replyStyle.explain') }}</NButton>
      <NButton size="tiny" quaternary @click="emit('send', EMOJI_CONTINUE_MESSAGE)">{{ t('replyStyle.continue') }}</NButton>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.emoji-reply { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.emoji-reply__meaning { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
</style>
