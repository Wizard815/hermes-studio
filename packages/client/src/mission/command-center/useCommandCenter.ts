import { computed, effectScope, reactive, watch, type ComputedRef } from 'vue'
import { decideAgentWork, fetchAgentWork, type AgentWork } from '@/api/studio/agent-work'
import { listJobs, type Job } from '@/api/hermes/jobs'
import { fetchSessions } from '@/api/studio/sessions'
import { fetchGithubInbox, fetchPlanLimits, type GithubInbox, type PlanLimits } from '@/api/studio/command-center'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { useSessionStateStore } from '@/stores/hermes/session-state'
import {
  buildInbox,
  collectAgents,
  markSeen as addSeen,
  readSeen,
  readSince,
  trackSince,
  unseenCount,
  writeSeen,
  writeSince,
  type ChatInfo,
  type InboxItem,
  type LiveAgent,
  type SinceMap,
} from './model'

/**
 * Command Center's shared state for the herdr page: one poller however many
 * dock tabs (and the Tools button's badge) read it. It runs while the herdr
 * page holds it (`acquire` / `release`).
 */

const WORK_MS = 20_000
const GITHUB_MS = 60_000
const TICK_MS = 30_000

const state = reactive({
  work: [] as AgentWork[],
  jobs: [] as Job[],
  github: null as GithubInbox | null,
  limits: [] as PlanLimits[],
  chats: new Map<string, ChatInfo>(),
  seen: readSeen(),
  since: readSince() as SinceMap,
  now: Date.now(),
  errors: { work: '', jobs: '', github: '', chats: '' },
  loading: false,
  chatsLoaded: false,
})

interface Instance {
  agents: ComputedRef<LiveAgent[]>
  inbox: ComputedRef<InboxItem[]>
  unseen: ComputedRef<number>
}

let instance: Instance | null = null
let holders = 0
let timers: number[] = []
let stopList: (() => void) | null = null
let chatTimer = 0

const message = (error: unknown) => (error as any)?.message || String(error)
/** A list from an answer that may lack it (an older or a different server): never undefined. */
const list = <T>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : [])

async function loadWork() {
  try { state.work = list((await fetchAgentWork())?.work); state.errors.work = '' } catch (error) { state.errors.work = message(error) }
}
async function loadJobs() {
  try { state.jobs = list(await listJobs()); state.errors.jobs = '' } catch (error) { state.errors.jobs = message(error) }
}
async function loadGithub(refresh = false) {
  try { state.github = await fetchGithubInbox(refresh); state.errors.github = '' } catch (error) { state.errors.github = message(error) }
}
async function loadLimits() {
  try { state.limits = list((await fetchPlanLimits())?.limits) } catch { state.limits = [] }
}
async function loadChats() {
  try {
    const chats = await fetchSessions(undefined, 1000)
    state.chats = new Map(chats.map(chat => [chat.id, { title: chat.title, agent: chat.agent, model: chat.model, source: chat.source }]))
    state.errors.chats = ''
    state.chatsLoaded = true
  } catch (error) { state.errors.chats = message(error) }
}

export async function refreshCommandCenter(options: { github?: boolean } = {}) {
  state.loading = true
  try { await Promise.all([loadWork(), loadJobs(), loadChats(), loadGithub(!!options.github), loadLimits()]) } finally { state.loading = false }
}

function create(): Instance {
  const herdr = useHerdrStore()
  const states = useSessionStateStore()
  const scope = effectScope(true)
  return scope.run(() => {
    const agents = computed(() => collectAgents(herdr.bridge?.panes || [], state.chats, {
      statusOf: id => states.statusOf(id),
      herdrLink: id => states.herdrLink(id),
      ids: () => [...states.sessions.keys()],
    }))
    // Until herdr, the chat list and live states have arrived, statuses are not final: keep the marks.
    watch([agents, () => state.chatsLoaded, () => states.connected, () => !!herdr.bridge], ([list, chatsLoaded, connected, bridge]) => {
      if (!chatsLoaded || !connected || !bridge) return
      state.since = trackSince(state.since, list, Date.now())
      writeSince(state.since)
    }, { immediate: true })
    const inbox = computed(() => buildInbox({ agents: agents.value, since: state.since, work: state.work, jobs: state.jobs, github: state.github, seen: state.seen }))
    const unseen = computed(() => unseenCount(inbox.value))
    return { agents, inbox, unseen }
  })!
}

export function useCommandCenter() {
  if (!instance) instance = create()
  const states = useSessionStateStore()

  function acquire() {
    holders++
    if (holders > 1) return
    states.start()
    void refreshCommandCenter()
    timers = [
      window.setInterval(() => { void loadWork(); void loadJobs() }, WORK_MS),
      window.setInterval(() => { void loadGithub(); void loadLimits() }, GITHUB_MS),
      window.setInterval(() => { state.now = Date.now() }, TICK_MS),
    ]
    stopList = states.onListChanged(() => {
      if (chatTimer) return
      chatTimer = window.setTimeout(() => { chatTimer = 0; void loadChats() }, 300)
    })
  }

  function release() {
    holders = Math.max(0, holders - 1)
    if (holders) return
    for (const timer of timers) window.clearInterval(timer)
    timers = []
    stopList?.()
    stopList = null
    if (chatTimer) window.clearTimeout(chatTimer)
    chatTimer = 0
  }

  function markSeen(items: Array<Pick<InboxItem, 'key' | 'at'>>) {
    state.seen = addSeen(state.seen, items)
    writeSeen(state.seen)
  }

  async function decide(workId: string, decision: 'approve' | 'reject') {
    await decideAgentWork(workId, decision)
    await loadWork()
  }

  return { state, ...instance, acquire, release, markSeen, decide, refresh: refreshCommandCenter, reloadGithub: () => loadGithub(true) }
}

/** Test hook. */
export function resetCommandCenter() {
  instance = null
  holders = 0
  for (const timer of timers) window.clearInterval(timer)
  timers = []
  state.work = []
  state.jobs = []
  state.github = null
  state.chats = new Map()
  state.seen = readSeen()
  state.since = {}
}
