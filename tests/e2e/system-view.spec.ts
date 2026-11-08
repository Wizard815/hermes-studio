import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const GB = 1024 ** 3

function snapshot(sample: number) {
  return {
    timestamp: Date.now(),
    host: { hostname: 'tower', platform: 'linux', distro: 'Unraid', release: '7.1', arch: 'x64', uptimeSeconds: 3 * 86400 + 7200, cpuModel: 'AMD Ryzen 9' },
    cpu: { percent: 20 + sample, cores: [10, 55, 3, 90], loadAverage: [] },
    memory: { totalBytes: 64 * GB, usedBytes: 24 * GB, availableBytes: 40 * GB, swapTotalBytes: 0, swapUsedBytes: 0 },
    disks: [{ mount: '/mnt/user', fs: 'shfs', type: 'fuse', sizeBytes: 8000 * GB, usedBytes: 5000 * GB, percent: 62.5 }],
    network: [{ iface: 'br0', rxBytesPerSec: 2048 * (sample + 1), txBytesPerSec: 512 }],
    processes: { total: 3, running: 1, list: [
      { pid: 812, parentPid: 1, name: 'plex', user: 'nobody', state: 'running', cpuPercent: 33.2, memPercent: 4, memRssBytes: 2 * GB, command: '/usr/lib/plexmediaserver' },
      { pid: 77, parentPid: 1, name: 'node', user: 'root', state: 'sleeping', cpuPercent: 2.5, memPercent: 1, memRssBytes: 300 * 1024 ** 2, command: 'node studio' },
      { pid: 990, parentPid: 1, name: 'dockerd', user: 'root', state: 'sleeping', cpuPercent: 1.1, memPercent: 0.5, memRssBytes: 120 * 1024 ** 2, command: 'dockerd' },
    ] },
    serverPid: 77,
  }
}

async function openFixture(page: Page) {
  const requests: Array<{ method: string; path: string; body: any }> = []
  const errors: string[] = []
  let sample = 0
  let webState = 'running'
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); (window as any).__APP_VERSION__ = 'test' })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() })
    if (url.pathname === '/api/studio/system') return route.fulfill({ json: snapshot(sample++) })
    if (url.pathname === '/api/studio/system/docker') {
      return route.fulfill({ json: { available: true, version: '27.3.1', containers: [
        { id: 'aaaaaaaaaaaa', name: 'nginx-proxy', image: 'nginx:1.27', state: webState, status: webState === 'running' ? 'Up 2 days' : 'Exited (0)', ports: ['443→443/tcp'] },
      ] } })
    }
    if (url.pathname.endsWith('/stop')) { webState = 'exited'; return route.fulfill({ json: { ok: true } }) }
    if (url.pathname.endsWith('/logs')) return route.fulfill({ json: { logs: 'nginx: ready\n' } })
    return route.fulfill({ json: { ok: true } })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/system-view.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__system_view__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  return { requests, errors }
}

test('shows live resources and ends a process but never Studio itself', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await page.goto('/__system_view__')
  await expect(page.getByTestId('system-view')).toContainText('tower')
  await expect(page.getByTestId('system-cpu').locator('.system-cores li')).toHaveCount(4)
  // A second sample arrives on its own.
  await expect(page.getByTestId('system-cpu').locator('.system-value')).toHaveText('21.0%', { timeout: 6000 })
  await expect(page.getByTestId('system-memory')).toContainText('24.0 GB / 64.0 GB')

  const rows = page.getByTestId('system-process')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('plex')
  await expect(rows.filter({ hasText: 'node' })).toContainText('Studio')
  await expect(rows.filter({ hasText: 'node' }).getByRole('button')).toHaveCount(0)

  await page.getByTestId('system-filter').locator('input').fill('plex')
  await expect(rows).toHaveCount(1)
  await rows.nth(0).getByRole('button', { name: 'End' }).click()
  await page.locator('.n-popconfirm').getByRole('button', { name: /confirm|ok|yes/i }).click()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/system/processes/812/signal')?.body).toEqual({ signal: 'SIGTERM' })
  expect(errors).toEqual([])
})

test('stops a Docker container and reads its logs', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await page.goto('/__system_view__')
  const container = page.getByTestId('system-container')
  await expect(container).toContainText('nginx-proxy')
  await expect(container).toContainText('443→443/tcp')
  await container.getByRole('button', { name: 'Stop' }).click()
  await expect.poll(() => requests.some(r => r.path === '/api/studio/system/docker/containers/aaaaaaaaaaaa/stop')).toBe(true)
  await expect(container.getByRole('button', { name: 'Start' })).toBeVisible()
  await container.getByRole('button', { name: 'Logs' }).click()
  await expect(container.locator('.system-logs')).toHaveText('nginx: ready\n')
  expect(errors).toEqual([])
})
