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
// Messages one person sends within this many seconds draw as one block.
const GROUP_SECONDS = 300
// A notice that opens with this mark is drawn as a problem, not as a note.
const PROBLEM = '!'

const NO_SETUP: ChatSetup = {
  name: '',
  room: '',
  clientId: '',
  isMuted: false,
}

const setup = atom({ plugin: 'side-chat', key: 'setup' } as const, NO_SETUP, {
  shape: 'setup-2',
})
const messages = atom({ plugin: 'side-chat', key: 'messages' } as const, [], {
  shape: 'messages-1',
})
const isPrimed = atom({ plugin: 'side-chat', key: 'isPrimed' } as const, false)
const notice = atom({ plugin: 'side-chat', key: 'notice' } as const, '')
const sent = atom({ plugin: 'side-chat', key: 'sent' } as const, 0)
const unread = atom({ plugin: 'side-chat', key: 'unread' } as const, 0)
const isLeaving = atom({ plugin: 'side-chat', key: 'isLeaving' } as const, false)
// The clock, to the minute: writing it redraws the ages beside the messages.
const minute = atom({ plugin: 'side-chat', key: 'minute' } as const, 0)

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

/** The code with its middle hidden: it is a secret, and the pane stays open. */
const mask = (room: string): string =>
  room.replace(/^(.{4})-.{4}-.{4}-(.{4})$/, '$1-····-····-$2')

function ago(nowMs: number, timeSeconds: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - timeSeconds)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`

  return `${Math.floor(seconds / 86400)}d`
}

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
    isMuted: (await $.store.get('muted')) === true,
  }
  const held = await read($, setup)

  if (
    held.name !== stored.name ||
    held.room !== stored.room ||
    held.clientId !== stored.clientId ||
    held.isMuted !== stored.isMuted
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

  await announce(
    $,
    who,
    fresh.filter(one => one.cid !== who.clientId),
  )
}

/**
 * Tells the person a friend wrote: a toast in each open session, and one
 * native notification for the machine, claimed through the shared store.
 */
async function announce(
  $: Engine,
  who: ChatSetup,
  fresh: ChatMessage[],
): Promise<void> {
  const last = fresh[fresh.length - 1]
  if (last === undefined) return
  await update($, unread, count => count + fresh.length)
  if (who.isMuted) return
  const line = cut(last.text.replace(/\s+/g, ' '), 140)
  $.ui.toast(`${last.from}: ${line}`, { timeoutMs: 8000 })
  if (asText(await $.store.get('notified')) === last.id) return
  await $.store.set('notified', last.id)

  try {
    await $.ui.notify(line, {
      title:
        fresh.length > 1
          ? `${last.from} (${fresh.length} new messages)`
          : last.from,
      key: 'message',
    })
  } catch {
    // Notifications are off or refused: the toast and the pane still show it.
  }
}

async function clearUnread($: Engine): Promise<void> {
  if ((await read($, unread)) !== 0) await update($, unread, () => 0)
}

async function setMuted($: Engine, isMuted: boolean): Promise<void> {
  await $.store.set('muted', isMuted)
  await loadSetup($)
  await say(
    $,
    isMuted
      ? 'Muted: no popups for new messages.'
      : 'Popups are on for new messages.',
  )
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
      await say($, `${PROBLEM}The relay asked to slow down. Trying again in a minute.`)

      return
    }

    if (!answer.ok) {
      await say($, `${PROBLEM}Could not check for messages (relay said ${answer.status}).`)

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
    await say($, `${PROBLEM}Could not reach the relay. Still trying.`)
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
    const now = await $.clock.now()
    const thisMinute = Math.floor(now / 60000)

    if ((await read($, minute)) !== thisMinute) {
      await update($, minute, () => thisMinute)
    }

    if (who.room !== '') {
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
    await say($, `${PROBLEM}Type a name first.`)

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
    await say($, `${PROBLEM}That does not look like an invite code (xxxx-xxxx-xxxx-xxxx).`)

    return
  }

  await enterRoom($, room)
}

async function leaveRoom($: Engine): Promise<void> {
  await update($, isLeaving, () => false)
  await clearUnread($)
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
    await say($, `${PROBLEM}That message is too long to send. Split it in two.`)

    return
  }

  try {
    const answer = await $.http.fetch(`${SERVER}/${topicOf(who.room)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body,
    })

    if (!answer.ok) {
      await say($, `${PROBLEM}Not sent (relay said ${answer.status}). Try again.`)

      return
    }

    const mine = parseEvents(answer.text)
    await $.store.set('log', merge(asLog(await $.store.get('log')), mine))
    // A new key gives an empty field for the next message.
    await update($, sent, count => count + 1)
    await clearUnread($)
    await say($, '')
    await sync($, who)
  } catch {
    await say($, `${PROBLEM}Not sent: could not reach the relay. Try again.`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'friend',
      description: 'Open the chat pane to message your friend',
    })
    const who = await loadSetup($)
    const startedAt = Math.floor((await $.clock.now()) / 60000)
    await update($, minute, () => startedAt)
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
    await clearUnread($)
    void tick($, true)

    return { text: 'Friend chat opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const who = await read($, setup)
    const list = await read($, messages)
    const note = await read($, notice)
    const count = await read($, sent)
    const fresh = await read($, unread)
    const leaving = await read($, isLeaving)
    const nowMs = (await read($, minute)) * 60000
    const isMine = (one: ChatMessage): boolean => one.cid === who.clientId
    const friend = list.findLast(one => !isMine(one))?.from ?? ''
    const last = list[list.length - 1]

    // The small form on the desktop app: read at a glance, no controls.
    if (e.props.placement === 'widget') {
      const glance =
        who.room === ''
          ? 'Open to set up'
          : last === undefined
            ? 'No messages yet'
            : `${isMine(last) ? 'You' : last.from}: ${last.text}`

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between" gap={1}>
            <Text weight="semibold">{friend === '' ? TITLE : friend}</Text>
            {fresh > 0 && (
              <Text color="claude" size="caption">
                {fresh} new
              </Text>
            )}
          </Box>
          <Text dimColor maxLines={2}>
            {glance}
          </Text>
        </Box>
      )
    }

    const isProblem = note.startsWith(PROBLEM)
    const status =
      note === '' ? null : (
        <Text size="caption" dimColor={!isProblem} color={isProblem ? 'warning' : undefined}>
          {isProblem ? note.slice(PROBLEM.length) : note}
        </Text>
      )
    const privacy = (
      <Text dimColor size="caption">
        Claude can't see this chat.
      </Text>
    )

    if (who.name === '') {
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <Box flexDirection="column">
            <Text size="heading" weight="semibold">
              Chat with a friend
            </Text>
            <Text dimColor>
              Message a friend from here while you work. They need this mod
              too.
            </Text>
          </Box>
          <Input
            key="name"
            label="Your name"
            placeholder="How your friend will see you"
            submitLabel="Continue"
            autoFocus
            onSubmit={value => saveName($, value)}
          />
          {status}
          {privacy}
        </Box>
      )
    }

    if (who.room === '') {
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <Box flexDirection="column">
            <Text size="heading" weight="semibold">
              Hi {who.name}
            </Text>
            <Text dimColor>
              Start a chat and send its invite code to your friend, or join
              with a code they sent you.
            </Text>
          </Box>
          <Box>
            <Button
              key="create"
              variant="primary"
              label="Start a new chat"
              onPress={() => enterRoom($, newCode())}
            />
          </Box>
          <Input
            key="join"
            label="Or join with a code"
            placeholder="xxxx-xxxx-xxxx-xxxx"
            submitLabel="Join"
            onSubmit={value => joinRoom($, value)}
          />
          {status}
          <Text dimColor size="caption">
            Anyone with the code can read the chat, so share it privately.
          </Text>
        </Box>
      )
    }

    // Newest messages that fit the pane, counted by the rows they wrap to.
    const columns = Math.max(16, e.props.bodyColumns - 6)
    const room = Math.max(8, e.props.scroll.bodyRows - 8)
    const shown: ChatMessage[] = []
    let used = 0

    for (let at = list.length - 1; at >= 0; at -= 1) {
      const one = list[at]
      if (one === undefined) break
      const rows =
        2 +
        one.text
          .split('\n')
          .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0)
      if (shown.length > 0 && used + rows > room) break
      used += rows
      shown.unshift(one)
    }

    // Messages in a row from one person read as one block, as in Claude's chat.
    const groups: { key: string; isMine: boolean; from: string; items: ChatMessage[] }[] = []

    for (const one of shown) {
      const open = groups[groups.length - 1]
      const closes = open?.items[open.items.length - 1]

      if (
        open !== undefined &&
        closes !== undefined &&
        open.isMine === isMine(one) &&
        open.from === one.from &&
        one.time - closes.time < GROUP_SECONDS
      ) {
        open.items.push(one)
      } else {
        groups.push({ key: one.id, isMine: isMine(one), from: one.from, items: [one] })
      }
    }

    const hidden = list.length - shown.length
    const when = (group: { items: ChatMessage[] }): string => {
      const newest = group.items[group.items.length - 1]

      return newest === undefined || nowMs === 0 ? '' : ago(nowMs, newest.time)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box justifyContent="space-between" alignItems="center" gap={1}>
            <Text weight="semibold">
              {friend === '' ? 'Waiting for your friend' : friend}
            </Text>
            {leaving ? (
              <Box gap={1} alignItems="center">
                <Text dimColor size="caption">
                  Leave this chat?
                </Text>
                <Button key="leave-yes" plain label="Leave" onPress={() => leaveRoom($)} />
                <Button
                  key="leave-no"
                  plain
                  label="Stay"
                  onPress={() => update($, isLeaving, () => false)}
                />
              </Box>
            ) : (
              <Box gap={1}>
                <Button
                  key="mute"
                  plain
                  label={who.isMuted ? 'Unmute' : 'Mute'}
                  onPress={() => setMuted($, !who.isMuted)}
                />
                <Button
                  key="leave"
                  plain
                  label="Leave"
                  onPress={() => update($, isLeaving, () => true)}
                />
              </Box>
            )}
          </Box>
          <Box gap={1} alignItems="center">
            <Text dimColor size="caption" mono>
              {mask(who.room)}
            </Text>
            <Button
              key="copy"
              plain
              label="Copy invite code"
              onPress={async () => {
                const copied = await $.ui.copy({ text: who.room, surface: e.surface })
                await say(
                  $,
                  copied.isCopied
                    ? 'Invite code copied. Send it to your friend privately.'
                    : `${PROBLEM}Could not copy. Your code is ${who.room}`,
                )
              }}
            />
          </Box>
        </Box>

        {hidden > 0 && (
          <Text dimColor size="caption">
            {hidden} earlier {hidden === 1 ? 'message' : 'messages'}
          </Text>
        )}
        {list.length === 0 && (
          <Box flexDirection="column" paddingY={1}>
            <Text weight="semibold">No messages yet</Text>
            <Text dimColor>
              Send your invite code to a friend. Once they join, say hi.
            </Text>
          </Box>
        )}
        {groups.map(group =>
          group.isMine ? (
            <Box flexDirection="column" alignItems="flex-end" marginLeft={4}>
              <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="promptBorder"
                paddingX={1}
              >
                {group.items.map(one => (
                  <Text>{one.text}</Text>
                ))}
              </Box>
              <Text dimColor size="caption">
                {when(group)}
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column" marginRight={4}>
              <Box gap={1}>
                <Text size="caption" weight="semibold">
                  {group.from}
                </Text>
                <Text dimColor size="caption">
                  {when(group)}
                </Text>
              </Box>
              {group.items.map(one => (
                <Text>{one.text}</Text>
              ))}
            </Box>
          ),
        )}

        <Box flexDirection="column">
          <Input
            key={`message-${count}`}
            placeholder={friend === '' ? 'Write a message' : `Message ${friend}`}
            submitLabel="Send"
            autoFocus
            onInput={() => clearUnread($)}
            onSubmit={value => send($, value)}
          />
          {status ?? privacy}
        </Box>
      </Box>
    )
  }).catch(($, e) => {
    // A build that refuses a prop used above still gets a readable pane.
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>Friend chat needs a newer Claude Code to draw.</Text>
  })
}
