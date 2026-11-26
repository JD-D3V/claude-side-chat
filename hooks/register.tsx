import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChatMessage, ChatSetup } from '../types'

// Messages travel through a public relay (ntfy.sh). Both people hold the same
// chat code; it names the relay topic, so anyone holding the code can read and
// post. Nothing here reaches the model: the pane only draws what arrives.
const SERVER = 'https://ntfy.sh'
const PANE = 'side-chat'
const TITLE = 'Friend chat'
const TICK_MS = 4000
const POLL_MS = 8000
const BACKOFF_MS = 60000
const KEEP = 200
const MAX_BODY_BYTES = 3800
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

const NO_SETUP: ChatSetup = { name: '', room: '', clientId: '' }

const setup = atom({ plugin: 'side-chat', key: 'setup' } as const, NO_SETUP, {
  shape: 'setup-1',
})
const messages = atom({ plugin: 'side-chat', key: 'messages' } as const, [], {
  shape: 'messages-1',
})
const isPrimed = atom({ plugin: 'side-chat', key: 'isPrimed' } as const, false)
const notice = atom({ plugin: 'side-chat', key: 'notice' } as const, '')
const sent = atom({ plugin: 'side-chat', key: 'sent' } as const, 0)

type Engine = EngineInterface

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : ''

const clean = (value: string, max: number): string =>
  value
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .slice(0, max)
    .trim()

const cut = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value

const topicOf = (room: string): string => `sidechat-${room}`

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const letters = Array.from(
    bytes,
    byte => CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? 'a',
  )

  return [0, 4, 8, 12].map(at => letters.slice(at, at + 4).join('')).join('-')
}

function asLog(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return []

  return value.filter(
    (one): one is ChatMessage =>
      typeof one === 'object' &&
      one !== null &&
      typeof one.id === 'string' &&
      typeof one.time === 'number' &&
      typeof one.from === 'string' &&
      typeof one.cid === 'string' &&
      typeof one.text === 'string',
  )
}

/** Reads the relay's answer: one JSON event per line, ours wrapped inside. */
function parseEvents(body: string): ChatMessage[] {
  const found: ChatMessage[] = []

  for (const line of body.split('\n')) {
    if (line.trim() === '') continue

    try {
      const row = JSON.parse(line)
      if (row?.event !== 'message' || typeof row.id !== 'string') continue
      const inner = JSON.parse(String(row.message))
      if (typeof inner?.text !== 'string') continue
      const text = clean(inner.text, 2000)
      if (text === '') continue

      found.push({
        id: row.id,
        time: Number(row.time) || 0,
        from: clean(asText(inner.from), 40) || 'Friend',
        cid: asText(inner.cid).slice(0, 80),
        text,
      })
    } catch {
      // Not one of ours: someone else's post on the topic, or a cut line.
    }
  }

  return found
}

function merge(log: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(log.map(one => [one.id, one]))
  for (const one of incoming) byId.set(one.id, one)

  return [...byId.values()]
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
    .slice(-KEEP)
}

/** The setup is kept across sessions in the store; state mirrors it to draw. */
async function loadSetup($: Engine): Promise<ChatSetup> {
  let clientId = asText(await $.store.get('clientId'))

  if (clientId === '') {
    clientId = crypto.randomUUID()
    await $.store.set('clientId', clientId)
  }

  const stored: ChatSetup = {
    name: asText(await $.store.get('name')),
    room: asText(await $.store.get('room')),
    clientId,
  }
  const held = await read($, setup)

  if (
    held.name !== stored.name ||
    held.room !== stored.room ||
    held.clientId !== stored.clientId
  ) {
    await update($, setup, () => stored)
  }

  return stored
}

async function say($: Engine, text: string): Promise<void> {
  if ((await read($, notice)) !== text) await update($, notice, () => text)
}

/** Copies the stored log into this session's state; toasts what is new. */
async function sync($: Engine, who: ChatSetup): Promise<void> {
  const log = who.room === '' ? [] : asLog(await $.store.get('log'))
  const held = await read($, messages)
  const wasPrimed = await read($, isPrimed)
  const known = new Set(held.map(one => one.id))
  const fresh = log.filter(one => !known.has(one.id))

  if (fresh.length > 0 || log.length !== held.length) {
    await update($, messages, () => log)
  }

  if (!wasPrimed) {
    await update($, isPrimed, () => true)

    return
  }

  for (const one of fresh.filter(one => one.cid !== who.clientId).slice(-3)) {
    $.ui.toast(`${one.from}: ${cut(one.text, 140)}`, { timeoutMs: 8000 })
  }
}

let backoffUntil = 0

/** Asks the relay for what arrived since the last message this machine saw. */
async function poll($: Engine, who: ChatSetup): Promise<void> {
  const cursor = asText(await $.store.get('cursor'))
  const since = cursor === '' ? '12h' : encodeURIComponent(cursor)
  const url = `${SERVER}/${topicOf(who.room)}/json?poll=1&since=${since}`

  try {
    const answer = await $.http.fetch(url)

    if (answer.status === 429) {
      backoffUntil = (await $.clock.now()) + BACKOFF_MS
      await say($, 'The relay asked to slow down. Trying again in a minute.')

      return
    }

    if (!answer.ok) {
      await say($, `Could not check for messages (relay said ${answer.status}).`)

      return
    }

    const incoming = parseEvents(answer.text)

    if (incoming.length > 0) {
      const log = merge(asLog(await $.store.get('log')), incoming)
      await $.store.set('log', log)
      // The relay answers in the order it stored them: its last is the cursor.
      await $.store.set('cursor', incoming[incoming.length - 1]?.id ?? cursor)
    }

    await say($, '')
  } catch {
    await say($, 'Could not reach the relay. Still trying.')
  }
}

let isBusy = false

/**
 * One round: every open session on this machine ticks, and they share one
 * poll through the store, so the relay hears from the machine once a period.
 */
async function tick($: Engine, isForced = false): Promise<void> {
  if (isBusy) return
  isBusy = true

  try {
    const who = await loadSetup($)

    if (who.room !== '') {
      const now = await $.clock.now()
      const polledAt = Number(await $.store.get('polledAt')) || 0
      const isDue = now - polledAt >= POLL_MS && now >= backoffUntil

      if (isForced || isDue) {
        await $.store.set('polledAt', now)
        await poll($, who)
      }
    }

    await sync($, who)
  } finally {
    isBusy = false
  }
}

async function saveName($: Engine, value: string): Promise<void> {
  const name = clean(value, 40)

  if (name === '') {
    await say($, 'Type a name first.')

    return
  }

  await $.store.set('name', name)
  await say($, '')
  await loadSetup($)
}

async function enterRoom($: Engine, room: string): Promise<void> {
  await $.store.set('room', room)
  await $.store.delete('log')
  await $.store.delete('cursor')
  await update($, isPrimed, () => false)
  await say($, '')
  await tick($, true)
}

async function joinRoom($: Engine, value: string): Promise<void> {
  const room = value.trim().toLowerCase().replace(/\s+/g, '')

  if (!/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/.test(room)) {
    await say($, 'That does not look like a chat code (xxxx-xxxx-xxxx-xxxx).')

    return
  }

  await enterRoom($, room)
}

async function leaveRoom($: Engine): Promise<void> {
  await $.store.delete('room')
  await $.store.delete('log')
  await $.store.delete('cursor')
  await say($, '')
  await sync($, await loadSetup($))
}

async function send($: Engine, value: string): Promise<void> {
  const text = clean(value, 2000)
  if (text === '') return
  const who = await loadSetup($)
  if (who.room === '') return
  const body = JSON.stringify({
    v: 1,
    from: who.name,
    cid: who.clientId,
    text,
  })

  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    await say($, 'That message is too long to send. Split it in two.')

    return
  }

  try {
    const answer = await $.http.fetch(`${SERVER}/${topicOf(who.room)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body,
    })

    if (!answer.ok) {
      await say($, `Not sent (relay said ${answer.status}). Try again.`)

      return
    }

    const mine = parseEvents(answer.text)
    await $.store.set('log', merge(asLog(await $.store.get('log')), mine))
    // A new key gives an empty field for the next message.
    await update($, sent, count => count + 1)
    await say($, '')
    await sync($, who)
  } catch {
    await say($, 'Not sent: could not reach the relay. Try again.')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'friend',
      description: 'Open the chat pane to message your friend',
    })
    const who = await loadSetup($)
    await sync($, who)
    void $.ui.open(
      who.room === ''
        ? { id: PANE, title: TITLE }
        : { id: PANE, title: TITLE, placement: 'widget' },
    )
    $.clock.every(TICK_MS, () => {
      void tick($)
    })

    return next(e)
  })

  on('command.run', { command: 'friend' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void tick($, true)

    return { text: 'Friend chat opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const who = await read($, setup)
    const list = await read($, messages)
    const note = await read($, notice)
    const count = await read($, sent)
    const nameOf = (one: ChatMessage): string =>
      one.cid === who.clientId ? 'You' : one.from
    const last = list[list.length - 1]

    if (e.props.placement === 'widget') {
      const glance =
        who.room === ''
          ? 'Open to set up'
          : last === undefined
            ? 'No messages yet'
            : `${nameOf(last)}: ${last.text}`

      return (
        <Box flexDirection="column">
          <Text weight="semibold">{TITLE}</Text>
          <Text dimColor maxLines={2}>
            {glance}
          </Text>
        </Box>
      )
    }

    const warning = note === '' ? null : <Text color="warning">{note}</Text>

    if (who.name === '') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">Chat with a friend</Text>
          <Text dimColor>
            What you type here goes to your friend's Claude app, and what they
            type shows up here. Claude does not read either side.
          </Text>
          <Input
            key="name"
            label="Your name"
            placeholder="what your friend will see"
            submitLabel="next"
            autoFocus
            onSubmit={value => saveName($, value)}
          />
          {warning}
        </Box>
      )
    }

    if (who.room === '') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">Hi {who.name}</Text>
          <Text dimColor>
            Start a chat and send its code to your friend, or paste the code
            they sent you. Anyone holding the code can read the chat, so share
            it privately.
          </Text>
          <Button
            key="create"
            variant="primary"
            label="Start a new chat"
            onPress={() => enterRoom($, newCode())}
          />
          <Input
            key="join"
            label="Friend's code"
            placeholder="xxxx-xxxx-xxxx-xxxx"
            submitLabel="join"
            onSubmit={value => joinRoom($, value)}
          />
          {warning}
        </Box>
      )
    }

    // Newest messages that fit the pane, counted by the rows they wrap to.
    const columns = Math.max(16, e.props.bodyColumns)
    const room = Math.max(6, e.props.scroll.bodyRows - 6)
    const shown: ChatMessage[] = []
    let used = 0

    for (let at = list.length - 1; at >= 0; at -= 1) {
      const one = list[at]
      if (one === undefined) break
      const rows =
        1 +
        one.text
          .split('\n')
          .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0)
      if (shown.length > 0 && used + rows > room) break
      used += rows
      shown.unshift(one)
    }

    const hidden = list.length - shown.length

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>Chat code {who.room}</Text>
          <Box gap={2}>
            <Button
              key="copy"
              plain
              label="Copy code"
              onPress={async () => {
                const copied = await $.ui.copy({
                  text: who.room,
                  surface: e.surface,
                })
                await say(
                  $,
                  copied.isCopied
                    ? 'Code copied. Send it to your friend.'
                    : 'Could not copy. Select the code above instead.',
                )
              }}
            />
            <Button
              key="leave"
              plain
              label="Leave chat"
              onPress={() => leaveRoom($)}
            />
          </Box>
        </Box>
        {hidden > 0 && <Text dimColor>{hidden} earlier not shown</Text>}
        {list.length === 0 && (
          <Text dimColor>
            No messages yet. Once your friend joins with the code, say hi.
          </Text>
        )}
        {shown.map(one => (
          <Box flexDirection="column">
            <Text weight="semibold" dimColor={one.cid === who.clientId}>
              {nameOf(one)}
            </Text>
            <Text>{one.text}</Text>
          </Box>
        ))}
        {warning}
        <Input
          key={`message-${count}`}
          placeholder="Message"
          submitLabel="send"
          autoFocus
          onSubmit={value => send($, value)}
        />
      </Box>
    )
  })
}
