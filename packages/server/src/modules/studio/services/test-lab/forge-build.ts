import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { create as tar } from 'tar'
import { forgeGitEnv, onForge, type ForgeConfig } from '../forge'

const run = promisify(execFile)

/** The forge's repos need FORGE_TOKEN (sign-in is required), which Docker's own git build can't send. */
export function buildsFromForge(gitUrl: string, forge: ForgeConfig | null): boolean {
  return onForge(gitUrl.split('#')[0], forge)
}

/**
 * A Docker build context (tar) of `url#ref` on the forge: a shallow clone with the
 * token as a one-off header for the forge's addresses, without .git. The token is
 * masked in any error.
 */
export async function forgeBuildContext(gitUrl: string, forge: ForgeConfig): Promise<Buffer> {
  const [url, ref] = gitUrl.split('#')
  const dir = await mkdtemp(join(tmpdir(), 'studio-testlab-src-'))
  try {
    const args = ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, join(dir, 'src')]
    try {
      await run('git', args, { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...forgeGitEnv(forge), GIT_TERMINAL_PROMPT: '0' } })
    } catch (error: any) {
      let reason = String(error?.stderr || error?.message || error).trim().split('\n').filter(Boolean).at(-1) || 'git clone failed'
      if (forge.token) reason = reason.split(forge.token).join('****')
      throw new Error(`Could not clone ${url} from the forge: ${reason}${/401|403|Authentication|could not read Username/i.test(reason) ? '. Check FORGE_TOKEN (needs read:repository)' : ''}`)
    }
    await rm(join(dir, 'src', '.git'), { recursive: true, force: true })
    const chunks: Buffer[] = []
    const stream = tar({ cwd: join(dir, 'src'), portable: true }, ['.'])
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
