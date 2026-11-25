import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

const candidates = [
  { key: 'claude-code:c1', kind: 'claude-code', originalId: 'c1', title: 'Fix the flaky login test', startedAt: 1777629600, lastActive: 1777629700, messageCount: 4, cwd: '/work/app', model: '', existingSessionId: null, cwdExists: true, resumable: true, skipReason: null },
  { key: 'hermes:h1', kind: 'hermes', originalId: 'h1', title: 'Plan the garden', startedAt: 1767225600, lastActive: 1767225700, messageCount: 4, cwd: null, model: '', sourceProfile: 'default', existingSessionId: null, cwdExists: false, resumable: false, skipReason: null },
  { key: 'codex:x1', kind: 'codex', originalId: 'x1', title: 'List the files', startedAt: 1767000000, lastActive: 1767000100, messageCount: 4, cwd: '/gone', model: '', existingSessionId: 'import-old', cwdExists: false, resumable: false, skipReason: null },
  { key: 'hermes:e1', kind: 'hermes', originalId: 'e1', title: 'Hermes chat', startedAt: 1766000000, lastActive: 1766000000, messageCount: 0, cwd: null, model: '', existingSessionId: null, cwdExists: false, resumable: false, skipReason: 'empty' },
]

/** Import chats: pick a folder, preview with duplicates and skips, choose some, import, follow progress, open a result. API mocked. */
test('Import chats: preview, choose, import with progress, open the new chat', async ({ page }) => {
  const errors: string[] = []
  let started: any = null
  let polls = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en') })
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/studio/chat-import/scan') {
      const body = request.postDataJSON()
      if (body.path === 'relative') return route.fulfill({ status: 400, json: { error: 'Enter a full path that starts with / (or ~ for Studio\'s home folder)' } })
      return route.fulfill({ json: { id: 'scan1', label: body.path, upload: false, createdAt: 1, candidates, truncated: false, counts: { hermes: 2, 'claude-code': 1, codex: 1, openclaw: 0 }, skippedFiles: 0, errors: [] } })
    }
    if (path === '/api/studio/chat-import/scans/scan1/import') {
      started = request.postDataJSON()
      return route.fulfill({ json: { id: 'job1', scanId: 'scan1', status: 'running', total: started.keys.length, done: 0, imported: [], skipped: [], failed: [] } })
    }
    if (path === '/api/studio/chat-import/jobs/job1') {
      polls += 1
      const done = polls > 1
      return route.fulfill({ json: { id: 'job1', scanId: 'scan1', status: done ? 'done' : 'running', total: 1, done: done ? 1 : 0,
        imported: done ? [{ key: 'claude-code:c1', kind: 'claude-code', title: 'Fix the flaky login test', sessionId: 'import-abc' }] : [], skipped: [], failed: [] } })
    }
    if (path === '/api/hermes/profiles') return route.fulfill({ json: { profiles: [{ name: 'default', active: false, alias: '' }, { name: 'work', active: true, alias: '' }] } })
    if (path === '/api/studio/session-categories') return route.fulfill({ json: { categories: [{ id: 7, name: 'Imported', parent_id: null, created_at: 1, updated_at: 1 }] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/chat-import.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__chat_import__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__chat_import__')

  await expect(page.getByText('API keys, tokens and .env files')).toBeVisible()
  await page.getByTestId('chat-import-scan').click()
  await expect(page.getByTestId('chat-import-error')).toHaveText('Enter a folder path first.')
  await page.getByLabel('Folder path').fill('relative')
  await page.getByTestId('chat-import-scan').click()
  await expect(page.getByTestId('chat-import-error')).toContainText('Enter a full path')

  await page.getByRole('button', { name: "Use Studio's home" }).click()
  await page.getByTestId('chat-import-scan').click()
  const preview = page.getByTestId('chat-import-preview')
  await expect(preview).toContainText('2 ready to import, 1 already imported, 1 skipped.')
  await expect(page.getByTestId('chat-import-count-claude-code')).toContainText('1 chats')
  await expect(page.getByTestId('chat-import-item-claude-code')).toContainText('Can continue in its agent (same session)')
  await expect(preview).toContainText('Already imported')
  await expect(preview).toContainText('Skipped: no messages')
  await expect(preview).toContainText('/gone (not on this server)')

  // Leave the Hermes chat out.
  await page.getByRole('checkbox', { name: 'Import "Plan the garden"' }).click()
  await page.getByTestId('chat-import-folder').click()
  await page.locator('.n-base-select-option', { hasText: 'Imported' }).click()
  await page.getByTestId('chat-import-start').click()
  await expect.poll(() => started).toEqual({ keys: ['claude-code:c1'], profile: 'work', categoryId: 7 })
  await expect(page.getByTestId('chat-import-summary')).toHaveText('1 imported, 0 skipped, 0 failed.')
  await expect(page.getByTestId('chat-import-progress')).toHaveText('1 of 1 chats')
  await page.getByRole('link', { name: 'Fix the flaky login test' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).chatImportFixture.route())).toBe('/hermes/session/import-abc')
  expect(errors).toEqual([])
})
