import { describe, expect, it } from 'vitest'
import { PhoneTools, deviceQuote, parseFocusedPackage, parseNotifications, type PhoneToolDeps } from '../../packages/server/src/modules/studio/services/android/agent-tools'
import { classifyPhoneAction, phoneActionNeedsApproval } from '../../packages/server/src/modules/studio/services/android/agent-policy'
import { compactUiTree, parseUiDump } from '../../packages/server/src/modules/studio/services/android/ui-tree'
import { normalizeSettings } from '../../packages/server/src/modules/studio/services/android/manager'
import { trustPatternMatches } from '../../packages/shared/watcher'

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.chat" clickable="false" bounds="[0,0][1080,2400]">
<node index="0" text="Inbox &amp; more" resource-id="com.example.chat:id/title" class="android.widget.TextView" package="com.example.chat" clickable="false" bounds="[40,100][600,180]" />
<node index="1" text="" content-desc="Compose" resource-id="com.example.chat:id/fab" class="android.widget.ImageButton" package="com.example.chat" clickable="true" bounds="[900,2100][1040,2240]" />
<node index="2" text="" resource-id="com.example.chat:id/search" class="android.widget.EditText" package="com.example.chat" clickable="true" focused="true" bounds="[40,200][1040,300]" />
<node index="3" text="Send" resource-id="com.example.chat:id/send" class="android.widget.Button" package="com.example.chat" clickable="true" bounds="[800,1800][1000,1900]" />
<node index="4" text="" resource-id="" class="android.view.View" package="com.example.chat" clickable="false" bounds="[0,0][0,0]" />
</node></hierarchy>`

/** A fake phone behind a fake adb: records every adb call. */
function fakePhone(overrides: Partial<PhoneToolDeps> = {}, focused = 'com.example.notes') {
  const calls: string[] = []
  const events: Array<[string, any]> = []
  const alerts: any[] = []
  let mode: 'ask' | 'guarded' | 'auto' = 'ask'
  let trusted = false
  const deps: PhoneToolDeps = {
    adb: async args => {
      calls.push(args.join(' '))
      const cmd = args.slice(2).join(' ')
      if (cmd.startsWith('exec-out uiautomator')) return { stdout: Buffer.from(`UI hierchary dumped\n${DUMP}`) }
      if (cmd.startsWith('exec-out screencap')) return { stdout: Buffer.from('PNGDATA') }
      if (cmd === 'shell wm size') return { stdout: Buffer.from('Physical size: 1080x2400') }
      if (cmd === 'shell dumpsys window') return { stdout: Buffer.from(`  mCurrentFocus=Window{abc u0 ${focused}/${focused}.Main}`) }
      if (cmd.startsWith('shell pm list packages')) return { stdout: Buffer.from('package:com.whatsapp\npackage:com.example.chat\n') }
      if (cmd.startsWith('shell dumpsys notification')) return { stdout: Buffer.from('  NotificationRecord(0x1: pkg=com.whatsapp user=UserHandle{0} id=1)\n      android.title=String (Mum)\n      android.text=String (Call me)\n') }
      if (cmd === 'shell echo hi') return { stdout: Buffer.from('hi\n') }
      return { stdout: Buffer.from('') }
    },
    listDevices: async () => [
      { serial: 'emulator-5554', state: 'device', kind: 'emulator', model: 'sdk', product: 'sdk', avd: 'Pixel_8' },
      { serial: 'R5CT1', state: 'device', kind: 'usb', model: 'Galaxy', product: 'a52' },
    ],
    allowedDevices: () => ['emulator-5554'],
    installApk: async () => ({ message: 'Success', packageName: 'com.example.app' }),
    compress: async (_png, width) => ({ data: Buffer.from('JPEG'), mime: 'image/jpeg', width, height: Math.round(width * 2400 / 1080) }),
    approvalMode: () => mode,
    trusted: () => trusted,
    alert: input => alerts.push(input),
    emit: (event, payload) => events.push([event, payload]),
    pullDir: () => '/tmp/studio-pulled-test',
    sleep: async () => {},
    ...overrides,
  }
  const tools = new PhoneTools(deps)
  return { tools, calls, events, alerts, setMode: (m: typeof mode) => { mode = m }, trust: (t: boolean) => { trusted = t } }
}

/** Answers the next question the Android page would show. */
async function answer(phone: ReturnType<typeof fakePhone>, allow: boolean) {
  for (let i = 0; i < 50 && !phone.tools.approvals().length; i += 1) await new Promise(r => setTimeout(r, 5))
  const [question] = phone.tools.approvals()
  expect(question).toBeTruthy()
  phone.tools.respond(question.id, allow)
  return question
}

describe('the screen as text', () => {
  it('keeps what a person sees or uses, with ids, labels, pixels and what can be done', () => {
    const elements = parseUiDump(DUMP)
    expect(elements.map(el => el.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(compactUiTree(elements)).toBe([
      '[e1] TextView "Inbox & more" #title (320,140)',
      '[e2] ImageButton "Compose" #fab (970,2170) tap',
      '[e3] EditText #search (540,250) tap type focused',
      '[e4] Button "Send" #send (900,1850) tap',
    ].join('\n'))
  })
})

describe('which phone actions ask first', () => {
  it('reads never ask; taps ask in ask mode; shell, installs and settings/payments/messages ask unless auto', () => {
    expect(phoneActionNeedsApproval(classifyPhoneAction({ action: 'screen' }).level, 'ask')).toBe(false)
    const tap = classifyPhoneAction({ action: 'tap', pkg: 'com.example.notes', target: 'Next' })
    expect(tap.level).toBe('act')
    expect(phoneActionNeedsApproval(tap.level, 'ask')).toBe(true)
    expect(phoneActionNeedsApproval(tap.level, 'guarded')).toBe(false)
    expect(classifyPhoneAction({ action: 'shell' }).level).toBe('danger')
    expect(classifyPhoneAction({ action: 'tap', pkg: 'com.android.settings' })).toMatchObject({ level: 'danger', reason: expect.stringContaining('settings') })
    expect(classifyPhoneAction({ action: 'tap', pkg: 'com.whatsapp' })).toMatchObject({ level: 'danger', reason: expect.stringContaining('messages') })
    expect(classifyPhoneAction({ action: 'open_app', target: 'com.google.android.apps.walletnfcrel' }).level).toBe('danger')
    expect(classifyPhoneAction({ action: 'tap', pkg: 'com.example.shop', target: 'Buy now' }).level).toBe('danger')
    expect(classifyPhoneAction({ action: 'open_url', target: 'tel:123' }).level).toBe('danger')
    expect(phoneActionNeedsApproval('danger', 'guarded')).toBe(true)
    expect(phoneActionNeedsApproval('danger', 'auto')).toBe(false)
  })
})

describe('phone tools on a fake adb', () => {
  it('only uses devices the person opened to agents (none by default)', async () => {
    expect(normalizeSettings({}).agentDevices).toEqual([])
    expect(normalizeSettings({ agentDevices: ['emulator-5554', 'bad serial;', 'emulator-5554'] }).agentDevices).toEqual(['emulator-5554'])
    const none = fakePhone({ allowedDevices: () => [] })
    await expect(none.tools.run({ action: 'screen' })).rejects.toThrow(/No device is open to agents/)
    const phone = fakePhone()
    await expect(phone.tools.run({ action: 'screen', arguments: { device: 'R5CT1' } })).rejects.toThrow(/not open to agents/)
    const list = await phone.tools.run({ action: 'devices' })
    expect(list.text).toContain('emulator-5554: Pixel_8 (device)')
    expect(list.text).toContain('1 other device(s) are connected but not open to agents.')
  })

  it('reads the screen and a small screenshot without asking', async () => {
    const phone = fakePhone()
    const screen = await phone.tools.run({ action: 'screen' })
    expect(screen.text).toContain('app com.example.chat · 4 elements')
    expect(screen.text).toContain('[e4] Button "Send" #send (900,1850) tap')
    const shot = await phone.tools.run({ action: 'screenshot', arguments: { width: 9999 } })
    expect(shot.image).toEqual({ data: Buffer.from('JPEG').toString('base64'), mimeType: 'image/jpeg' })
    expect(shot.text).toContain('1080x2400 screen')
    expect(phone.tools.approvals()).toEqual([])
    expect(phone.alerts).toEqual([])
  })

  it('ask mode: a tap by id waits for the person, then taps the element center and logs where', async () => {
    const phone = fakePhone()
    await phone.tools.run({ action: 'screen' })
    const run = phone.tools.run({ action: 'tap', arguments: { id: 'e2' }, agent: 'hermes', sessionId: 'chat-1' })
    const question = await answer(phone, true)
    expect(question).toMatchObject({ serial: 'emulator-5554', device: 'Pixel_8', action: 'tap', summary: 'tap e2 "Compose"', agent: 'hermes', trustValue: 'android:emulator-5554:com.example.notes:tap' })
    await expect(run).resolves.toMatchObject({ text: expect.stringContaining('Done: tap e2') })
    expect(phone.calls).toContain('-s emulator-5554 shell input tap 970 2170')
    const [done] = phone.tools.log()
    expect(done).toMatchObject({ status: 'done', point: { x: 970 / 1080, y: 2170 / 2400 } })
    expect(phone.alerts.map(a => a.kind)).toEqual(['approval_asked', 'approval_approved'])
    expect(phone.events.map(([event]) => event)).toEqual(expect.arrayContaining(['agent.approval', 'agent.approval.resolved', 'agent.action']))
  })

  it('a denied action does not run and tells the agent to stop', async () => {
    const phone = fakePhone()
    const run = phone.tools.run({ action: 'type', arguments: { text: "it's me" } })
    await answer(phone, false)
    await expect(run).rejects.toThrow(/did not allow/)
    expect(phone.calls.some(call => call.includes('input text'))).toBe(false)
    expect(phone.tools.log()[0].status).toBe('denied')
  })

  it('guarded mode: taps go ahead, a shell command still asks, and a trust rule answers it', async () => {
    const phone = fakePhone()
    phone.setMode('guarded')
    await phone.tools.run({ action: 'tap', arguments: { x: 10, y: 20 } })
    expect(phone.calls).toContain('-s emulator-5554 shell input tap 10 20')
    const run = phone.tools.run({ action: 'shell', arguments: { command: 'echo hi' } })
    await answer(phone, true)
    await expect(run).resolves.toEqual({ text: 'hi\n' })
    phone.trust(true)
    await expect(phone.tools.run({ action: 'shell', arguments: { command: 'echo hi' } })).resolves.toEqual({ text: 'hi\n' })
    expect(phone.alerts.at(-1)).toMatchObject({ kind: 'approval_trusted' })
  })

  it('a trust rule made from an ordinary tap does not let a "Send" tap through', async () => {
    let rules = ['android:emulator-5554:com.example.notes:tap']
    const phone = fakePhone({ trusted: ({ value }) => rules.some(rule => trustPatternMatches(rule, value)) })
    await phone.tools.run({ action: 'screen' })
    await phone.tools.run({ action: 'tap', arguments: { id: 'e2' } })
    expect(phone.tools.approvals()).toEqual([])
    const run = phone.tools.run({ action: 'tap', arguments: { id: 'e4' } })
    const question = await answer(phone, false)
    expect(question).toMatchObject({ reason: 'presses "Send"', trustValue: 'android:emulator-5554:com.example.notes:tap:danger' })
    await expect(run).rejects.toThrow()
    rules = ['android:emulator-5554:com.example.notes:tap:danger']
    await phone.tools.run({ action: 'screen' })
    await phone.tools.run({ action: 'tap', arguments: { id: 'e4' } })
    await phone.tools.run({ action: 'tap', arguments: { id: 'e2' } })
    rules = ['android:emulator-5554:*']
    await phone.tools.run({ action: 'tap', arguments: { id: 'e4' } })
    expect(phone.tools.approvals()).toEqual([])
    expect(phone.calls.filter(call => call.includes('input tap'))).toHaveLength(4)
  })

  it('guarded mode still asks before tapping in a messaging app', async () => {
    const phone = fakePhone({}, 'com.whatsapp')
    phone.setMode('guarded')
    const run = phone.tools.run({ action: 'tap', arguments: { x: 5, y: 5 } })
    const question = await answer(phone, true)
    expect(question.reason).toContain('messages')
    await run
  })

  it('auto mode never asks; a person taking over stops acting but not looking', async () => {
    const phone = fakePhone()
    phone.setMode('auto')
    await phone.tools.run({ action: 'key', arguments: { key: 'back' } })
    expect(phone.calls).toContain('-s emulator-5554 shell input keyevent 4')
    await phone.tools.run({ action: 'open_url', arguments: { url: "https://example.com/a?b=1&c='x'" } })
    expect(phone.calls).toContain(`-s emulator-5554 shell am start -a android.intent.action.VIEW -d ${deviceQuote("https://example.com/a?b=1&c='x'")}`)
    phone.tools.setTakeOver('emulator-5554', true)
    await expect(phone.tools.run({ action: 'tap', arguments: { x: 1, y: 1 } })).rejects.toThrow(/taken over/)
    await expect(phone.tools.run({ action: 'screen' })).resolves.toBeTruthy()
    phone.tools.setTakeOver('emulator-5554', false)
    await expect(phone.tools.run({ action: 'swipe', arguments: { direction: 'up' } })).resolves.toBeTruthy()
    expect(phone.calls.at(-3)).toBe('-s emulator-5554 shell input swipe 540 1560 540 840 300')
  })

  it('refuses ids from an old read, points off the screen and unknown keys or actions', async () => {
    const phone = fakePhone()
    phone.setMode('auto')
    await expect(phone.tools.run({ action: 'tap', arguments: { id: 'e9' } })).rejects.toThrow(/Read the screen again/)
    await expect(phone.tools.run({ action: 'tap', arguments: { x: 5000, y: 1 } })).rejects.toThrow(/outside/)
    await expect(phone.tools.run({ action: 'key', arguments: { key: 'reboot' } })).rejects.toThrow(/key is one of/)
    await expect(phone.tools.run({ action: 'wipe' })).rejects.toThrow(/action must be one of/)
    await expect(phone.tools.run({ action: 'pull', arguments: { remote: 'relative/path' } })).rejects.toThrow(/absolute path/)
  })

  it('lists apps and notifications as data', async () => {
    const phone = fakePhone()
    expect((await phone.tools.run({ action: 'apps' })).text).toContain('com.whatsapp')
    expect((await phone.tools.run({ action: 'notifications' })).text).toContain('- com.whatsapp: Mum — Call me')
    expect(parseNotifications('nothing')).toEqual([])
    expect(parseFocusedPackage('mCurrentFocus=Window{1 u0 com.android.settings/com.android.settings.Settings}')).toBe('com.android.settings')
  })
})
