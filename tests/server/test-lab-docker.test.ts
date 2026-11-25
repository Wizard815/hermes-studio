import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDocker } from './fixtures/fake-docker'
import { LabDocker, belongsTo, containerBody, runLabels, LABEL_RUN, LABEL_INSTANCE } from '../../packages/server/src/modules/studio/services/test-lab/docker'

const ME = 'instance-a'
let fake: FakeDocker
let docker: LabDocker

beforeEach(async () => {
  fake = new FakeDocker()
  await fake.start()
  docker = new LabDocker(() => fake.socket)
})
afterEach(async () => { await fake.stop() })

function seedHost() {
  // Not Test Lab at all.
  const foreign = fake.add('containers', { Names: ['/plex'], Labels: { 'com.docker.compose.project': 'media' } })
  const foreignNet = fake.add('networks', { Name: 'proxy', Labels: {} })
  const foreignVol = fake.add('volumes', { Labels: {} })
  // Another Studio's run, same run id.
  const other = fake.add('containers', { Names: ['/other-studio'], Labels: runLabels('run-1', 'instance-b', 1) })
  // Another run of this Studio.
  const sibling = fake.add('containers', { Names: ['/sibling'], Labels: runLabels('run-2', ME, 1) })
  // Looks similar but has no instance label.
  const lookalike = fake.add('containers', { Names: ['/studio-testlab-run-1-x'], Labels: { [LABEL_RUN]: 'run-1' } })
  // This run.
  const mine = [
    fake.add('containers', { Names: ['/app'], Labels: runLabels('run-1', ME, 1, { 'studio.testlab.app': 'vikunja' }) }),
    fake.add('containers', { Names: ['/runner'], Labels: runLabels('run-1', ME, 1, { 'studio.testlab.app': 'runner' }) }),
  ]
  const myNet = fake.add('networks', { Name: 'studio-testlab-run-1', Labels: runLabels('run-1', ME, 1) })
  const myVol = fake.add('volumes', { Labels: runLabels('run-1', ME, 1) })
  const myImage = fake.add('images', { Id: 'studio-testlab/orb:run-1', Labels: runLabels('run-1', ME, 1) })
  const otherImage = fake.add('images', { Id: 'nginx:1.29.8-alpine', Labels: {} })
  return { foreign, foreignNet, foreignVol, other, sibling, lookalike, mine, myNet, myVol, myImage, otherImage }
}

describe('Test Lab Docker', () => {
  it('removes only the run\'s labelled containers, networks, volumes and built images', async () => {
    const host = seedHost()
    const removed = await docker.removeRun(ME, 'run-1')
    expect(removed.containers.sort()).toEqual(host.mine.map(c => c.Id).sort())
    expect(removed.networks).toEqual(['studio-testlab-run-1'])
    expect(removed.volumes).toEqual([host.myVol.Id])
    expect(removed.images).toEqual([host.myImage.Id])
    for (const kept of [host.foreign, host.other, host.sibling, host.lookalike]) expect(fake.containers.has(kept.Id)).toBe(true)
    expect(fake.networks.has(host.foreignNet.Id)).toBe(true)
    expect(fake.volumes.has(host.foreignVol.Id)).toBe(true)
    expect(fake.images.has(host.otherImage.Id)).toBe(true)
    // No write call ever named something outside the run.
    const outside = [host.foreign, host.other, host.sibling, host.lookalike, host.foreignNet, host.foreignVol, host.otherImage].map(o => o.Id)
    expect(fake.writes().filter(call => outside.some(id => call.path.includes(encodeURIComponent(id))))).toEqual([])
    // Container deletes also drop anonymous volumes.
    expect(fake.writes().filter(call => call.path.startsWith('/containers/')).every(call => call.path.endsWith('?force=1&v=1'))).toBe(true)
  })

  it('asks Docker by label (both labels) when filters work', async () => {
    fake.ignoreFilters = false
    seedHost()
    await docker.removeRun(ME, 'run-1')
    const list = fake.calls.find(call => call.path.startsWith('/containers/json'))!
    const filters = JSON.parse(new URLSearchParams(list.path.split('?')[1]).get('filters')!)
    expect(filters.label).toEqual([`${LABEL_RUN}=run-1`, `${LABEL_INSTANCE}=${ME}`])
  })

  it('lists this Studio\'s runs with when they were made', async () => {
    fake.add('containers', { Labels: runLabels('old', ME, 1000) })
    fake.add('networks', { Name: 'n', Labels: runLabels('old', ME, 900) })
    fake.add('containers', { Labels: runLabels('new', ME, 5000) })
    fake.add('containers', { Labels: runLabels('theirs', 'instance-b', 1) })
    fake.add('containers', { Labels: {} })
    const runs = await docker.labelledRuns(ME)
    expect(Object.fromEntries(runs)).toEqual({ old: 900, new: 5000 })
  })

  it('makes an internal network and locked-down containers', async () => {
    await docker.createNetwork('studio-testlab-x', runLabels('x', ME, 1))
    expect(fake.calls.at(-1)!.body).toMatchObject({ Internal: true, Driver: 'bridge', Labels: { [LABEL_RUN]: 'x' } })
    const body = containerBody({ name: 'r', image: 'node:24', labels: runLabels('x', ME, 1), network: 'net', aliases: ['runner'], readOnlyRoot: true, dropAllCaps: true, user: '1000:1000' })
    expect(body).toMatchObject({ User: '1000:1000', HostConfig: { NetworkMode: 'net', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] }, NetworkingConfig: { EndpointsConfig: { net: { Aliases: ['runner'] } } } })
    expect((body.HostConfig as any).PortBindings).toBeUndefined()
  })

  it('reports a failed pull from the progress stream', async () => {
    fake.failPull.add('mirror.gcr.io/library/nginx:1')
    await expect(docker.pull('mirror.gcr.io/library/nginx:1')).rejects.toThrow(/pull access denied/)
    await docker.pull('nginx:1')
    expect(await docker.hasImage('nginx:1')).toBe(true)
  })

  it('belongsTo needs the instance, the run label and (when given) the run id', () => {
    expect(belongsTo(runLabels('a', ME, 1), ME, 'a')).toBe(true)
    expect(belongsTo(runLabels('a', ME, 1), ME)).toBe(true)
    expect(belongsTo(runLabels('a', ME, 1), ME, 'b')).toBe(false)
    expect(belongsTo(runLabels('a', 'x', 1), ME, 'a')).toBe(false)
    expect(belongsTo({ [LABEL_INSTANCE]: ME }, ME)).toBe(false)
    expect(belongsTo(undefined, ME)).toBe(false)
  })

  it('says Docker is unreachable without a socket', async () => {
    expect(await new LabDocker(() => null).status()).toEqual({ available: false })
    expect(await docker.status()).toMatchObject({ available: true, version: '99.0-fake' })
  })
})
