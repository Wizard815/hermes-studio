import { describe, expect, it } from 'vitest'
import { buildActiveSessionMenuOptions, buildSessionContextMenuOptions, withHerdrMenuGroup } from '@/components/hermes/chat/session-menu-options'
import { HERDR_SESSION_COMMAND_DEFINITION, isHerdrSessionCommand, isKnownBridgeSessionCommand, isKnownEkkoSessionCommand } from '@/utils/hermes/bridge-session-commands'

const labels = {
  pin: 'Pin', unpin: 'Unpin', rename: 'Rename', archive: 'Archive', workspace: 'Workspace', model: 'Model',
  category: 'Category', export: 'Export', exportFull: 'Full', exportCompressed: 'Compressed', open: 'Open',
  copyLink: 'Copy link', copyId: 'Copy id', openInHerdr: 'Open in herdr',
}
const keys = (includeHerdr?: boolean) => buildSessionContextMenuOptions({
  pinned: false, includeArchive: true, includeModel: true, categoryChildren: [], labels, includeHerdr,
}).map(option => option.key)

describe('chat list menu: Open in herdr', () => {
  it('is there only when asked for, next to the other open actions', () => {
    expect(keys(true)).toContain('open-herdr')
    expect(keys(true).indexOf('open-herdr')).toBe(keys(true).indexOf('open-link') - 1)
    expect(keys(false)).not.toContain('open-herdr')
    expect(keys(undefined)).not.toContain('open-herdr')
  })
})

describe('/herdr command', () => {
  it('matches only the bare command', () => {
    expect(isHerdrSessionCommand('/herdr')).toBe(true)
    expect(isHerdrSessionCommand('  /HERDR ')).toBe(true)
    expect(isHerdrSessionCommand('/herdr now')).toBe(false)
    expect(isHerdrSessionCommand('herdr')).toBe(false)
    expect(HERDR_SESSION_COMMAND_DEFINITION.name).toBe('herdr')
  })

  it('is not a bridge or Ekko command, so the chat store never sends it as one', () => {
    expect(isKnownBridgeSessionCommand('/herdr')).toBe(false)
    expect(isKnownEkkoSessionCommand('/herdr')).toBe(false)
  })
})

describe('chat header menu: herdr group (phones in herdr mode)', () => {
  const base = buildActiveSessionMenuOptions({ outline: 'Outline', rename: 'Rename', open: 'Open', copyId: 'Copy id' })

  it('adds nothing without herdr actions', () => {
    expect(withHerdrMenuGroup(base, 'herdr', [])).toBe(base)
  })

  it('adds herdr actions as one group after the chat actions', () => {
    const options = withHerdrMenuGroup(base, 'herdr', [
      { key: 'open-studio', label: 'Open in Studio' },
      { key: 'reopen', label: 'Reopen closed chat', disabled: true },
      { key: 'key:search', label: 'Search' },
    ])
    expect(options.slice(0, base.length)).toEqual(base)
    expect(options[base.length]).toMatchObject({ type: 'divider' })
    const group = options[base.length + 1] as any
    expect(group).toMatchObject({ type: 'group', label: 'herdr' })
    expect(group.children).toEqual([
      { key: 'herdr:open-studio', label: 'Open in Studio', disabled: false },
      { key: 'herdr:reopen', label: 'Reopen closed chat', disabled: true },
      { key: 'herdr:key:search', label: 'Search', disabled: false },
    ])
  })
})
