import { expect, mock, test } from 'claude-code/testing'

import { deriveKeys, seal } from '../hooks/crypto'

const PANE = {
  plugin: 'side-chat',
  component: 'Pane',
  requestId: 'side-chat',
  props: {
    title: 'Friend chat',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type Posted = { id: string; time: number; event: 'message'; topic: string; message: string }

const answer = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })

test('with a live stream a message arrives at once, with every popup', async ($, on) => {
  const relay: Posted[] = []
  const fetched: string[] = []
  const spawned: string[][] = []
  const ran: string[][] = []
  const notified: string[] = []
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const keys = deriveKeys('aaaa-bbbb-cccc-dddd')
  mock.store(on, {
    name: 'Alex',
    contacts: [{ id: 'c1', label: 'New chat', code: 'aaaabbbbccccdddd', ...keys, me: 'me' }],
  })
  on('command.register', () => ({ value: { command: 'friend' } }))
  const opened: string[] = []
  const closed: string[] = []
  on('ui.open', (_, e) => {
    opened.push(`${e.id}:${String((e as { placement?: string }).placement ?? '')}`)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', (_, e) => {
    notified.push(e.text)

    return { value: { isSent: true, channel: 'client' } }
  })
  on('session.machine', () => ({
    value: { sysname: 'Darwin', release: '25', machine: 'arm64', packageManagers: [], runtimes: [] },
  }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])

    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('http.fetch', (_, e) => {
    fetched.push(e.url)

    return answer('')
  })
  // The relay's stream, as curl would write it: an opening line, then each
  // message the moment it is posted.
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: '{"id":"o1","time":1,"event":"open","topic":"x"}\n' }
    await clock.sleep(20_000)
    const frame = seal(keys, { from: 'Sam', cid: 'other', ts: clock.now(), text: '-e hello' }) ?? ''
    const row: Posted = {
      id: 'm1',
      time: Math.floor(clock.now() / 1000),
      event: 'message',
      topic: keys.topic,
      message: frame,
    }
    relay.push(row)
    // One line split across two pieces, as a pipe may deliver it.
    const line = `${JSON.stringify(row)}\n`
    yield { stream: 'stdout' as const, text: line.slice(0, 50) }
    yield { stream: 'stdout' as const, text: line.slice(50) }
    await clock.sleep(3_600_000)

    return { value: { code: 0, signal: null } }
  })

  // A stream's pieces cross to the mod a step after the clock moves.
  const pass = async (ms: number): Promise<void> => {
    await clock.advance(ms)
    for (let step = 0; step < 5; step += 1) await clock.settle()
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pass(4_000)

  // Already set up: the mod does not open the pane by itself.
  expect(opened).toEqual([])

  // One curl, on the chat's topic, and the pane says the chat is live.
  expect(spawned.length).toBe(1)
  expect(spawned[0]?.[0]).toBe('curl')
  expect(spawned[0]?.at(-1)?.startsWith(`https://ntfy.sh/${keys.topic}/json?since=`)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Live/ })).toBeDefined()
  const pollsBefore = fetched.length

  // The message shows as the stream writes it, with no poll in between.
  await pass(20_500)
  expect(relay.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /^-e hello$/ })).toBeDefined()
  expect(fetched.length).toBe(pollsBefore)

  // Out of Claude: the system's notifier ran, the friend's text after `--`
  // where it cannot be read as a script, and Claude's own channel was spared.
  expect(ran.length).toBe(1)
  const guard = ran[0]?.indexOf('--') ?? -1
  expect(ran[0]?.[0]).toBe('osascript')
  expect(guard).toBeGreaterThan(0)
  expect(ran[0]?.slice(guard + 1)).toEqual(['-e hello', 'Sam'])
  expect(notified).toEqual([])

  // The pane has a close control of its own.
  await ui.press({ key: 'close' })
  expect(closed).toEqual(['side-chat'])

  // In Claude: a row above the prompt, which Dismiss takes away.
  const band = await $.ui.mount({
    plugin: 'side-chat',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, bodyColumns: 80 },
  } as never)
  expect((await band.find({ type: 'Text', text: /^Sam$/ }))?.text).toBe('Sam')
  expect(await band.find({ type: 'Text', text: /^-e hello$/ })).toBeDefined()
  await band.press({ key: 'alert-dismiss' })
  expect(await band.find({ type: 'Text', text: /^Sam$/ })).toBeUndefined()
  await band.unmount()
  await ui.unmount()
})
