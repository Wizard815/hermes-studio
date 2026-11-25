import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  builtinTemplateDir, isBuildUrl, isPinnedImage, loadTemplates, pullReference, validateTemplate,
} from '../../packages/server/src/modules/studio/services/test-lab/templates'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const base = { id: 'demo', name: 'Demo', description: 'x', image: 'nginx:1.29.8-alpine', port: 80, health: { path: '/' }, logins: [] }

describe('Test Lab templates', () => {
  it('ships valid templates for every app in the plan', () => {
    const { templates, problems } = loadTemplates([{ dir: builtinTemplateDir(), source: 'builtin' }])
    expect(problems).toEqual([])
    expect(templates.map(t => t.id).sort()).toEqual(['allglance', 'home-assistant', 'mattermost', 'mealie', 'nginx', 'pondering-orb', 'studio', 'vikunja'])
    for (const template of templates) {
      if (template.image) expect(isPinnedImage(template.image)).toBe(true)
      else expect(template.build).toBeDefined()
    }
  })

  it('needs a pinned image', () => {
    expect(isPinnedImage('vikunja/vikunja:2.7.1')).toBe(true)
    expect(isPinnedImage('ghcr.io/a/b@sha256:' + 'a'.repeat(64))).toBe(true)
    expect(isPinnedImage('localhost:5000/app:1.0')).toBe(true)
    for (const floating of ['nginx', 'nginx:latest', 'a/b:stable', 'a/b:nightly', 'localhost:5000/app', 'bad image:1']) expect(isPinnedImage(floating)).toBe(false)
    expect(validateTemplate({ ...base, image: 'nginx:latest' })).toEqual(['image: needs a fixed version (repo:1.2.3 or repo@sha256:…), not latest'])
  })

  it('says what is wrong with a template', () => {
    expect(validateTemplate(base)).toEqual([])
    expect(validateTemplate('x')).toEqual(['The file is not a JSON object'])
    const errors = validateTemplate({ id: 'Bad Id', port: 0, health: { path: 'x' }, logins: [{}], seed: [{ name: 's', method: 'FETCH', path: 'api', json: {}, form: {} }] })
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^id:/), 'name: missing', 'image or build: one is needed', 'port: a number from 1 to 65535',
      'health.path: a path starting with /', 'logins: a list of { username, password }',
      expect.stringMatching(/^seed\[0\]\.method/), 'seed[0].path: a path starting with /', 'seed[0]: json or form, not both',
    ]))
  })

  it('accepts git builds (https, optional #ref) and an empty URL the user fills in', () => {
    expect(isBuildUrl('https://github.com/Wizard815/pondering-orb.git#main')).toBe(true)
    expect(isBuildUrl('https://example.com/org/app')).toBe(true)
    expect(isBuildUrl('git@github.com:a/b.git')).toBe(false)
    expect(isBuildUrl('http://example.com/a/b')).toBe(false)
    expect(validateTemplate({ ...base, image: undefined, build: { git: '' } })).toEqual([])
    expect(validateTemplate({ ...base, image: undefined, build: { git: 'file:///etc' } })).toEqual(['build.git: an https git URL, optionally with #branch'])
    expect(validateTemplate({ ...base, build: { git: 'https://a.b/c', dockerfile: '../x' } })).toEqual(['build.dockerfile: a path inside the repository'])
  })

  it('adds the user\'s templates, replaces by id and lists broken files', () => {
    const custom = mkdtempSync(join(tmpdir(), 'tl-tpl-')); dirs.push(custom)
    writeFileSync(join(custom, 'nginx.json'), JSON.stringify({ ...base, id: 'nginx', name: 'My nginx' }))
    writeFileSync(join(custom, 'extra.json'), JSON.stringify({ ...base, id: 'extra' }))
    writeFileSync(join(custom, 'broken.json'), '{ nope')
    writeFileSync(join(custom, 'invalid.json'), JSON.stringify({ ...base, id: 'invalid', image: 'x:latest' }))
    const { templates, problems } = loadTemplates([{ dir: builtinTemplateDir(), source: 'builtin' }, { dir: custom, source: 'custom' }])
    expect(templates.find(t => t.id === 'nginx')).toMatchObject({ name: 'My nginx', source: 'custom' })
    expect(templates.find(t => t.id === 'extra')?.source).toBe('custom')
    expect(problems.map(p => p.file.split('/').pop()).sort()).toEqual(['broken.json', 'invalid.json'])
  })

  it('pulls Docker Hub images through the mirror, others as they are', () => {
    expect(pullReference('nginx:1.29.8-alpine', 'mirror.gcr.io')).toEqual({ from: 'mirror.gcr.io/library/nginx:1.29.8-alpine', fallback: 'nginx:1.29.8-alpine' })
    expect(pullReference('vikunja/vikunja:2.7.1', 'mirror.gcr.io/')).toEqual({ from: 'mirror.gcr.io/vikunja/vikunja:2.7.1', fallback: 'vikunja/vikunja:2.7.1' })
    expect(pullReference('ghcr.io/wizard815/orb:1.0', 'mirror.gcr.io')).toEqual({ from: 'ghcr.io/wizard815/orb:1.0' })
    expect(pullReference('nginx:1', '')).toEqual({ from: 'nginx:1' })
  })
})
