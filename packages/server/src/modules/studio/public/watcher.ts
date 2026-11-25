/** The Watcher (docs/watcher.md) for agent modules: record what a guard did, ask the trust rules, find pipelock. */
export { recordWatcherEvent, watcherTrusts, pipelockProxy, trustRequestFromAction } from '../services/watcher'
export type { TrustContext, TrustRequest, WatcherEventInput } from '../services/watcher'
