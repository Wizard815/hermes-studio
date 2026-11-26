import { shallowRef } from 'vue'

/**
 * "Share to Studio" from the Studio Own Android app (packages/android,
 * docs/android-devices.md). The app hands the page what was shared (text, a
 * link, images) as `window.__studioOwnShare` and a `studio-own-share` event;
 * the chat input picks it up so the person can check it before sending.
 */

export interface StudioOwnShareFile { name: string; type: string; data: string }
export interface StudioOwnShare { mode: 'new' | 'current'; text: string; files: StudioOwnShareFile[] }

const MAX_TEXT = 100_000
const MAX_FILES = 10
/** Matches the app's own cap (ShareIntent.MAX_IMAGE_BYTES), in base64 characters. */
const MAX_FILE_BASE64 = Math.ceil((8 * 1024 * 1024) / 3) * 4

/** Checks what the app sent; anything malformed is dropped rather than half-used. */
export function parseStudioOwnShare(raw: unknown): StudioOwnShare | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const mode = value.mode === 'current' ? 'current' : 'new'
  const text = typeof value.text === 'string' ? value.text.slice(0, MAX_TEXT) : ''
  const files = (Array.isArray(value.files) ? value.files : [])
    .slice(0, MAX_FILES)
    .filter((file): file is StudioOwnShareFile => !!file && typeof file === 'object'
      && typeof (file as StudioOwnShareFile).data === 'string'
      && (file as StudioOwnShareFile).data.length <= MAX_FILE_BASE64
      && /^[A-Za-z0-9+/]*={0,2}$/.test((file as StudioOwnShareFile).data)
      && typeof (file as StudioOwnShareFile).type === 'string'
      && /^image\/[a-z0-9.+-]+$/i.test((file as StudioOwnShareFile).type))
    .map(file => ({ name: String(file.name || 'shared').replace(/[\\/]/g, '_').slice(0, 120) || 'shared', type: file.type.toLowerCase(), data: file.data }))
  if (!text.trim() && !files.length) return null
  return { mode, text, files }
}

/** The text that goes into the chat input: after what is already typed, on its own paragraph. */
export function appendSharedText(current: string, shared: string): string {
  const add = shared.trim()
  if (!add) return current
  return current.trim() ? `${current.replace(/\s+$/, '')}\n\n${add}` : add
}

export function shareFilesToFiles(files: StudioOwnShareFile[]): File[] {
  return files.map(file => {
    const bytes = Uint8Array.from(atob(file.data), ch => ch.charCodeAt(0))
    return new File([bytes], file.name, { type: file.type })
  })
}

/** What the chat input should take in next (set by the app-level listener). */
export const pendingComposerShare = shallowRef<{ text: string; files: File[] } | null>(null)
