import { getApiKey, getBaseUrl, request } from '../client'

/** Test Lab (docs/test-lab.md): throwaway app containers and one agent test. */

export interface TestLabTemplateSummary {
  id: string
  name: string
  description: string
  image: string | null
  /** Git address it is built from ('' when the user must give one); null when it has an image. */
  build: string | null
  needsBuildUrl: boolean
  sizeMb: number | null
  port: number
  logins: Array<{ username: string; password: string; role?: string }>
  source: 'builtin' | 'custom'
}

export interface TestLabModel { id: string; provider: string; model: string; profile: string }

export interface TestLabSettings {
  registryMirror: string
  runnerImage: string
  browserImage: string
  defaultCapUsd: number
  defaultMinutes: number
  maxSteps: number
}

export interface TestLabStatus {
  docker: { available: boolean; version?: string; socket?: string; error?: string }
  settings: TestLabSettings
  templates: TestLabTemplateSummary[]
  problems: Array<{ file: string; errors: string[] }>
  models: TestLabModel[]
  customTemplateDir: string
}

export type TestLabStepKey = 'images' | 'network' | 'apps' | 'health' | 'seed' | 'agent' | 'report' | 'cleanup'
export type TestLabRunStatus = 'starting' | 'running' | 'passed' | 'failed' | 'stopped' | 'error'

export interface TestLabRun {
  id: string
  createdAt: number
  finishedAt?: number
  status: TestLabRunStatus
  stopReason?: 'cap' | 'time' | 'user' | 'limit' | 'restart'
  message?: string
  model: TestLabModel
  capUsd: number
  minutes: number
  instructions: string
  keepRunning: boolean
  browser: boolean
  steps: Array<{ key: TestLabStepKey; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; detail?: string }>
  apps: Array<{ id: string; name: string; url: string; state: string; message?: string; logins: TestLabTemplateSummary['logins'] }>
  transcript: Array<{ at: number; role: 'assistant' | 'tool' | 'system'; tool?: string; text: string }>
  screenshots: string[]
  logs: string[]
  cost: { gatewayUsd: number; tokens: number; unpricedCalls: number; openrouterBefore?: number; openrouterAfter?: number; openrouterUsd?: number; openrouterError?: string }
  report?: { summary: string; checks: Array<{ name: string; result: 'pass' | 'fail' | 'skip'; detail?: string }>; passed: number; failed: number; skipped: number }
  removed?: boolean
  active?: boolean
}

export interface TestLabRunSummary {
  id: string
  createdAt: number
  finishedAt?: number
  status: TestLabRunStatus
  stopReason?: TestLabRun['stopReason']
  model: TestLabModel
  removed?: boolean
  keepRunning: boolean
  apps: string[]
  passed?: number
  failed?: number
  costUsd: number
}

export interface StartTestLabRun {
  model: string
  apps: string[]
  instructions: string
  capUsd: number
  minutes: number
  keepRunning: boolean
  browser: boolean
  builds: Record<string, string>
}

const base = '/api/studio/test-lab'
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

export const fetchTestLab = () => request<TestLabStatus>(base)
export const saveTestLabSettings = (settings: Partial<TestLabSettings>) => request<TestLabSettings>(`${base}/settings`, json('PUT', settings))
export const fetchTestLabRuns = () => request<{ runs: TestLabRunSummary[] }>(`${base}/runs`)
export const startTestLabRun = (input: StartTestLabRun) => request<TestLabRun>(`${base}/runs`, json('POST', input))
export const fetchTestLabRun = (id: string) => request<TestLabRun>(`${base}/runs/${encodeURIComponent(id)}`)
export const stopTestLabRun = (id: string) => request<TestLabRun>(`${base}/runs/${encodeURIComponent(id)}/stop`, json('POST', {}))
export const removeTestLabRun = (id: string) => request<TestLabRun>(`${base}/runs/${encodeURIComponent(id)}/containers`, { method: 'DELETE' })

/** Screenshots, logs and the zip need the sign-in header, so they are fetched, not linked. */
async function fetchFile(path: string): Promise<Response> {
  const apiKey = getApiKey()
  const res = await fetch(`${getBaseUrl()}${path}`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} })
  if (!res.ok) throw new Error(`API Error ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  return res
}

export const fetchTestLabScreenshot = async (id: string, name: string) => (await fetchFile(`${base}/runs/${encodeURIComponent(id)}/screenshots/${encodeURIComponent(name)}`)).blob()
export const fetchTestLabLog = async (id: string, app: string) => (await fetchFile(`${base}/runs/${encodeURIComponent(id)}/logs/${encodeURIComponent(app)}`)).text()
export const fetchTestLabZip = async (id: string) => (await fetchFile(`${base}/runs/${encodeURIComponent(id)}/download`)).blob()
