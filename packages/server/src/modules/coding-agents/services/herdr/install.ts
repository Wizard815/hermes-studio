import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

/** herdr's own installer reads this manifest; Studio follows the same contract. */
export const HERDR_MANIFEST_URL = 'https://herdr.dev/latest.json'

export interface HerdrManifest {
  version: string
  assets: Record<string, string>
  sha256: Record<string, string>
}

export interface HerdrInstallResult {
  version: string
  binary: string
}

/** Manifest target name for this machine, or null when herdr ships no binary for it. */
export function herdrTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : null
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null
  if (!os || !cpu) return null
  // Windows ARM64 runs the x86_64 build under emulation (herdr docs).
  if (os === 'windows') return 'windows-x86_64'
  return `${os}-${cpu}`
}

export function parseHerdrManifest(raw: unknown): HerdrManifest {
  const value = raw as Partial<HerdrManifest> | null
  if (!value || typeof value.version !== 'string' || typeof value.assets !== 'object' || typeof value.sha256 !== 'object') {
    throw new Error('herdr release manifest is malformed')
  }
  return { version: value.version, assets: value.assets as Record<string, string>, sha256: value.sha256 as Record<string, string> }
}

async function findFile(dir: string, name: string, depth: number): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true })
  const hit = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === name)
  if (hit) return join(dir, hit.name)
  if (depth <= 0) return null
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = await findFile(join(dir, entry.name), name, depth - 1)
    if (nested) return nested
  }
  return null
}

async function fetchBytes(url: string, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (${response.status}) from ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Download the herdr release for this machine into `installDir`, verifying the
 * manifest's SHA-256 before anything is made executable. Windows releases are a
 * zip whose files must stay together (herdr.exe + its ConPTY runtime).
 */
export async function installHerdrRelease(input: {
  installDir: string
  manifestUrl?: string
  fetcher?: typeof fetch
  platform?: NodeJS.Platform
  arch?: string
}): Promise<HerdrInstallResult> {
  const fetcher = input.fetcher ?? fetch
  const platform = input.platform ?? process.platform
  const target = herdrTarget(platform, input.arch ?? process.arch)
  if (!target) throw Object.assign(new Error(`herdr has no release for ${platform}/${input.arch ?? process.arch}`), { status: 400 })
  const manifestUrl = input.manifestUrl || HERDR_MANIFEST_URL
  const manifestResponse = await fetcher(manifestUrl, { redirect: 'follow' })
  if (!manifestResponse.ok) throw new Error(`Could not read the herdr release manifest (${manifestResponse.status})`)
  const manifest = parseHerdrManifest(await manifestResponse.json())
  const url = manifest.assets[target]
  const expected = String(manifest.sha256[target] || '').toLowerCase()
  if (!url || !/^https?:\/\//.test(url)) throw new Error(`herdr ${manifest.version} has no download for ${target}`)
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`herdr ${manifest.version} has no valid checksum for ${target}`)

  const bytes = await fetchBytes(url, fetcher)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new Error('Downloaded herdr did not match its published checksum; nothing was installed')

  await mkdir(input.installDir, { recursive: true })
  const binaryName = platform === 'win32' ? 'herdr.exe' : 'herdr'
  const binary = join(input.installDir, binaryName)
  if (url.endsWith('.zip')) {
    const staging = `${input.installDir}.staging`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    const zip = new AdmZip(bytes)
    for (const entry of zip.getEntries()) {
      const name = entry.entryName.replace(/\\/g, '/')
      if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('herdr archive contains an unsafe path')
    }
    zip.extractAllTo(staging, true)
    await rm(input.installDir, { recursive: true, force: true })
    await rename(staging, input.installDir)
    const found = await findFile(input.installDir, binaryName, 3)
    if (!found) throw new Error(`herdr archive did not contain ${binaryName}`)
    return { version: manifest.version, binary: found }
  } else {
    const temp = `${binary}.download`
    await writeFile(temp, bytes, { mode: 0o755 })
    await chmod(temp, 0o755)
    await rename(temp, binary)
  }
  return { version: manifest.version, binary }
}
