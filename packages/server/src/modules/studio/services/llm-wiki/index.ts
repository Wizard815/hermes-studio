import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  getProfileDir, listProfileNames, readConfigYamlForProfile, saveEnvValueForProfile, updateConfigYamlForProfile,
} from '../../public/profile-config'
import { LlmWikiService } from './service'

export { LlmWikiError } from './client'
export { LLM_WIKI_PROVIDER, LLM_WIKI_TOKEN_ENV } from './service'

/** Where Studio keeps the provider's files: dist/server/assets after a build, the source tree in development. */
export function llmWikiPluginSource(): string {
  const candidates = [
    join(__dirname, 'assets', 'hermes-plugins', 'llm_wiki'),
    resolve(__dirname, '..', '..', '..', '..', 'assets', 'hermes-plugins', 'llm_wiki'),
    join(process.cwd(), 'dist', 'server', 'assets', 'hermes-plugins', 'llm_wiki'),
    join(process.cwd(), 'packages', 'server', 'src', 'assets', 'hermes-plugins', 'llm_wiki'),
  ]
  return candidates.find(dir => existsSync(join(dir, '__init__.py'))) || candidates[candidates.length - 1]
}

let service: LlmWikiService | null = null

export function getLlmWiki(): LlmWikiService {
  service ??= new LlmWikiService({
    profiles: listProfileNames,
    profileDir: getProfileDir,
    readConfig: readConfigYamlForProfile,
    updateConfig: updateConfigYamlForProfile,
    saveEnv: saveEnvValueForProfile,
    pluginSource: llmWikiPluginSource,
  })
  return service
}
