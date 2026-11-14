import { join } from 'node:path'
import { getWebUiHome } from '../modules/studio/public/config'
import { configureLlmWikiClient } from '../modules/studio/services/llmwiki/client'
import { configureLlmWikiMemory, startLlmWikiMemory } from '../modules/studio/services/llmwiki/memory'

/** LLMWIKI (the Obsidian memory vault): connection settings, recall and daily notes. */
export function startLlmWikiIntegration() {
  const dir = join(getWebUiHome(), 'llmwiki')
  configureLlmWikiClient(join(dir, 'settings.json'))
  configureLlmWikiMemory(dir)
  startLlmWikiMemory()
}
