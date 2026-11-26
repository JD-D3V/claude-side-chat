import { expect, mock, test } from 'claude-code/testing'

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

type Posted = { id: string; time: number; event: 'message'; message: string }

for (const surface of ['desktop', 'terminal'] as const) {
  test(`two people chat through the relay (${surface})`, async ($, on) => {
    // A relay kept in memory: one topic, as ntfy answers it.
    const topic: Posted[] = []
    const urls: string[] = []
    const toasts: string[] = []
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    on('command.register', () => ({ value: { command: 'friend' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('ui.toast', (_, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    on('http.fetch', (_, e) => {
      urls.push(e.url)

      if (e.init?.method === 'POST') {
        const row: Posted = {
          id: `m${topic.length + 1}`,
          time: 1000 + topic.length,
          event: 'message',
          message: String(e.init.body),
        }
        topic.push(row)

        return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(row) } }
      }

      const since = new URL(e.url).searchParams.get('since')
      const from = topic.findIndex(row => row.id === since) + 1
      const text = topic
        .slice(from)
        .map(row => JSON.stringify(row))
        .join('\n')

      return { value: { status: 200, ok: true, headers: {}, text } }
    })

    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })

    // First run: a name, then a new chat.
    await ui.input({ key: 'name', text: 'Alex' })
    await ui.press({ key: 'create' })
    const code = (await ui.find({ type: 'Text', text: /^Chat code / }))?.text
    expect(code).toMatch(/^Chat code [a-z0-9]{4}(-[a-z0-9]{4}){3}$/)

    // Sending posts to the relay and shows the message as mine.
    await ui.input({ key: 'message-0', text: 'hello there' })
    expect(topic.length).toBe(1)
    expect(JSON.parse(topic[0]?.message ?? '{}').from).toBe('Alex')
    expect(await ui.find({ type: 'Text', text: /^hello there$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^You$/ })).toBeDefined()
    // The field is a new, empty one after a send.
    expect(await ui.find({ key: 'message-1' })).toBeDefined()

    // The friend answers from their own machine; the next poll brings it in.
    topic.push({
      id: 'm2',
      time: 2000,
      event: 'message',
      message: JSON.stringify({ v: 1, from: 'Sam', cid: 'other', text: 'hey Alex' }),
    })
    await clock.advance(12_000)
    expect(await ui.find({ type: 'Text', text: /^hey Alex$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Sam$/ })).toBeDefined()
    expect(toasts).toEqual(['Sam: hey Alex'])

    // Every request went to the chat's own topic on the relay.
    const room = code?.replace('Chat code ', '')
    expect(urls.every(url => url.startsWith(`https://ntfy.sh/sidechat-${room}`))).toBe(true)
    await ui.unmount()
  })
}

const STRANGER = {
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: [
        '{"id":"x1","time":1,"event":"open"}',
        '{"id":"x2","time":2,"event":"message","message":"plain text from a stranger"}',
        'not json at all',
      ].join('\n'),
    },
  }

test('a post that is not one of ours is ignored', async ($, on) => {
  let polls = 0
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { name: 'Alex', room: 'aaaa-bbbb-cccc-dddd', clientId: 'me' })
  on('command.register', () => ({ value: { command: 'friend' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', () => {
    polls += 1

    return STRANGER
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(12_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(polls).toBeGreaterThan(0)
  expect(await ui.find({ type: 'Text', text: /^No messages yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /stranger/ })).toBeUndefined()
  await ui.unmount()
})
