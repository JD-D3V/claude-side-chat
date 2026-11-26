import { expect, mock, test } from 'claude-code/testing'

import { deriveKeys, open, seal } from '../hooks/crypto'

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

for (const surface of ['desktop', 'terminal'] as const) {
  test(`two people chat, sealed, through the relay (${surface})`, async ($, on) => {
    // A relay kept in memory, answering as ntfy does.
    const relay: Posted[] = []
    const urls: string[] = []
    const toasts: string[] = []
    const popups: { title?: string; text: string }[] = []
    let copied = ''
    const clock = mock.clock(on, { now: 1_800_000_000_000 })
    const post = (topic: string, message: string): Posted => {
      const row: Posted = {
        id: `m${relay.length + 1}`,
        time: Math.floor(clock.now() / 1000),
        event: 'message',
        topic,
        message,
      }
      relay.push(row)

      return row
    }
    mock.store(on)
    on('command.register', () => ({ value: { command: 'friend' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('ui.toast', (_, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    on('ui.notify', (_, e) => {
      popups.push({ title: e.title, text: e.text })

      return { value: { isSent: true, channel: 'client' } }
    })
    on('ui.copy', (_, e) => {
      copied = e.text

      return { value: { isCopied: true } }
    })
    on('http.fetch', (_, e) => {
      urls.push(e.url)
      const path = new URL(e.url).pathname.split('/')

      if (e.init?.method === 'POST') {
        return answer(JSON.stringify(post(path[1] ?? '', String(e.init.body))))
      }

      const topics = (path[1] ?? '').split(',')

      return answer(
        relay
          .filter(row => topics.includes(row.topic))
          .map(row => JSON.stringify(row))
          .join('\n'),
      )
    })

    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })

    // First run: a name, then a new chat, which opens at once.
    await ui.input({ key: 'name', text: 'Alex' })
    await ui.press({ key: 'create' })
    await ui.press({ key: 'copy' })
    expect(copied).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/)
    const masked = `${copied.slice(0, 4)}-····-····-${copied.slice(-4)}`
    expect((await ui.find({ type: 'Text', text: /····/ }))?.text).toBe(masked)
    const keys = deriveKeys(copied)

    // What is sent is sealed: the relay holds no readable text.
    await ui.input({ key: 'message-0', text: 'hello there' })
    expect(relay.length).toBe(1)
    const first = relay[0]?.message ?? ''
    expect(first.includes('hello')).toBe(false)
    expect(first.includes('Alex')).toBe(false)
    expect(first.length % 256).toBe(0)
    expect(open(keys, first)?.payload.text).toBe('hello there')
    expect(open(keys, first)?.payload.from).toBe('Alex')
    expect(await ui.find({ type: 'Text', text: /^hello there$/ })).toBeDefined()
    // The field is a new, empty one after a send.
    expect(await ui.find({ key: 'message-1' })).toBeDefined()

    // The friend answers from their own machine; the next poll brings it in.
    const reply = seal(keys, { from: 'Sam', cid: 'other', ts: clock.now(), text: 'hey Alex' }) ?? ''
    post(keys.topic, reply)
    await clock.advance(12_000)
    expect(await ui.find({ type: 'Text', text: /^hey Alex$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Sam$/ })).toBeDefined()
    expect(toasts).toEqual(['Sam: hey Alex'])
    expect(popups).toEqual([{ title: 'Sam', text: 'hey Alex' }])

    // Nothing else on the topic gets in: plain text, a frame sealed for
    // another chat, a changed frame, or a real frame posted a second time.
    const other = deriveKeys('zzzz-zzzz-zzzz-zzzz')
    post(keys.topic, JSON.stringify({ v: 1, from: 'Eve', cid: 'x', text: 'plain intruder' }))
    post(keys.topic, seal({ ...other, topic: keys.topic }, { from: 'Eve', cid: 'x', ts: clock.now(), text: 'wrong key' }) ?? '')
    post(keys.topic, `${reply.slice(0, 60)}${reply[60] === 'A' ? 'B' : 'A'}${reply.slice(61)}`)
    post(keys.topic, reply)
    await clock.advance(12_000)
    expect(await ui.find({ type: 'Text', text: /intruder|wrong key/ })).toBeUndefined()
    expect(toasts.length).toBe(1)
    expect(popups.length).toBe(1)

    // Muted, a new message still arrives but raises nothing.
    await ui.press({ key: 'mute' })
    post(keys.topic, seal(keys, { from: 'Sam', cid: 'other', ts: clock.now(), text: 'you there?' }) ?? '')
    await clock.advance(12_000)
    expect(await ui.find({ type: 'Text', text: /^you there\?$/ })).toBeDefined()
    expect(toasts.length).toBe(1)
    expect(popups.length).toBe(1)

    // Back at the list the chat is saved under the friend's name, and opens
    // again with no code.
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'create' })).toBeDefined()
    const row = await ui.find({ type: 'Button', text: /Sam/ })
    expect(row?.text).toMatch(/Sam: you there\?/)
    await ui.press({ key: row?.key ?? '' })
    expect(await ui.find({ type: 'Text', text: /^hey Alex$/ })).toBeDefined()

    // Removing asks first, then the chat is gone from the list.
    await ui.press({ key: 'leave' })
    await ui.press({ key: 'leave-yes' })
    expect(await ui.find({ key: 'create' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Sam/ })).toBeUndefined()

    // Every request went to the derived topic; the code itself never left.
    const bare = copied.replaceAll('-', '')
    expect(urls.length).toBeGreaterThan(3)
    expect(urls.every(url => url.startsWith(`https://ntfy.sh/${keys.topic}`))).toBe(true)
    expect(urls.some(url => url.includes(bare) || url.includes(copied))).toBe(false)
    expect(relay.some(one => one.message.includes(bare))).toBe(false)
    await ui.unmount()
  })
}

test('a chat saved by the first version becomes a sealed, saved chat', async ($, on) => {
  const urls: string[] = []
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on, { name: 'Alex', room: 'aaaa-bbbb-cccc-dddd', clientId: 'me' })
  on('command.register', () => ({ value: { command: 'friend' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    urls.push(e.url)

    return answer('')
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(12_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // The one saved chat opens by itself, on its new topic.
  expect(await ui.find({ type: 'Text', text: /^No messages yet/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /····/ }))?.text).toBe('aaaa-····-····-dddd')
  const keys = deriveKeys('aaaa-bbbb-cccc-dddd')
  expect(urls.length).toBeGreaterThan(0)
  expect(urls.every(url => url.startsWith(`https://ntfy.sh/${keys.topic}/`))).toBe(true)
  await ui.unmount()
})

test('a frame opens only with its own key, on its own topic, unchanged', async () => {
  const keys = deriveKeys('abcd-efgh-jkmn-pqrs')
  const same = deriveKeys(' ABCD efgh-JKMN pqrs ')
  const other = deriveKeys('abcd-efgh-jkmn-pqrt')
  const payload = { from: 'Alex', cid: 'c1', ts: 1, text: 'héllo 👋' }
  const frame = seal(keys, payload) ?? ''

  // The code reads the same however it was typed; one letter off, all differs.
  expect(same).toEqual(keys)
  expect(other.key).not.toBe(keys.key)
  expect(other.topic).not.toBe(keys.topic)
  expect(keys.topic).toMatch(/^sc2-[0-9a-f]{32}$/)
  expect(keys.topic.includes('abcd')).toBe(false)

  expect(open(keys, frame)?.payload).toEqual(payload)
  expect(open(other, frame)).toBe(null)
  expect(open({ ...keys, topic: other.topic }, frame)).toBe(null)
  expect(open(keys, `${frame.slice(0, 100)}${frame[100] === 'A' ? 'B' : 'A'}${frame.slice(101)}`)).toBe(null)
  expect(open(keys, 'not a frame')).toBe(null)
  expect(open(keys, JSON.stringify(payload))).toBe(null)

  // Two seals of one message share nothing, and sizes come in fixed steps.
  expect(seal(keys, payload)).not.toBe(frame)
  expect(frame.length).toBe(256)
  expect(seal(keys, { ...payload, text: 'x'.repeat(200) })?.length).toBe(512)
  expect(seal(keys, { ...payload, text: 'x'.repeat(2700) })?.length).toBe(3840)
  expect(seal(keys, { ...payload, text: 'x'.repeat(2900) })).toBe(null)
})
