import { shallowRef } from 'vue'

/**
 * Pin comments: click a spot on a screenshot or the browser view, write a
 * comment, and it goes to the open chat as
 * "Comment on <name> (pinned at 9% from the left, 25% from the top): <text>".
 * The chat that can take them registers itself as the target; with no target
 * the Comment buttons don't show.
 */
export type PinCommentSend = (text: string) => Promise<unknown> | unknown

export const pinCommentTarget = shallowRef<PinCommentSend | null>(null)

export function setPinCommentTarget(send: PinCommentSend | null): void {
  pinCommentTarget.value = send
}

/** A whole percentage from 0 to 100. */
export function pinPercent(offset: number, size: number): number {
  if (!size || !Number.isFinite(offset)) return 0
  return Math.min(100, Math.max(0, Math.round((offset / size) * 100)))
}

export function pinCommentText(name: string, x: number, y: number, text: string): string {
  const label = name.trim() || 'this image'
  return `Comment on ${label} (pinned at ${x}% from the left, ${y}% from the top): ${text.trim()}`
}

/** A readable name for an image: its file name, else its alt text. */
export function imageName(src: string, alt = ''): string {
  if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
    try {
      // Studio serves files as /api/studio/files/download?path=<file>.
      const url = new URL(src, 'http://x')
      for (const path of [url.searchParams.get('path') || '', url.pathname]) {
        const last = decodeURIComponent(path.split('/').filter(Boolean).at(-1) || '')
        if (/\.[a-z0-9]{2,5}$/i.test(last)) return last
      }
    } catch { /* not a URL */ }
  }
  return alt.trim() || 'this image'
}
