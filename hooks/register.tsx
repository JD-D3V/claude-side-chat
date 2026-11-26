import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Alert, ChatMessage, ChatSummary, Contact, Profile } from '../types'
import { deriveKeys, normalizeCode, open as openFrame, seal } from './crypto'

// Messages travel through a public relay (ntfy.sh), sealed on this machine
// before they leave it: the relay sees a topic name and sealed frames. Each
// saved chat keeps its invite code and the key derived from it in the store,
// never in `$.state`, which other mods can read. Nothing here reaches the
// model: the pane only draws what arrives.
const SERVER = 'https://ntfy.sh'
const PANE = 'side-chat'
const TITLE = 'Friend chat'
const TICK_MS = 2000
// How often this machine asks the relay, by how the chat is going. The relay
// allows one request each five seconds on average, with sixty saved up.
const POLL_HOT_MS = 3000
const POLL_LOW_MS = 6000
const POLL_IDLE_MS = 8000
// With the live stream up, polling is only a safety net.
const POLL_SAFETY_MS = 30000
const HOT_WINDOW_MS = 120000
const BUDGET_MAX = 60
const BUDGET_START = 40
const BUDGET_LOW = 20
const REFILL_MS = 5000
const BACKOFF_MS = 60000
const STUCK_MS = 60000
// One session on the machine holds the live stream; the others read what it
// files in the store. A holder that stops renewing is replaced.
const LEASE_MS = 15000
const HEARTBEAT_MS = 5000
// The relay writes a keepalive about every 45 seconds: silence this long
// means the connection is dead.
const STREAM_QUIET_MS = 100000
const STREAM_MAX_SECONDS = 900
// How long a new message stays in the row above the prompt if left alone.
const ALERT_MS = 120000
const KEEP = 200
const MAX_CONTACTS = 20
// A frame is read only if its own clock is within a day of the relay's: an
// old frame posted again later is dropped.
const MAX_SKEW_MS = 24 * 3600 * 1000
// The relay stores a message up to about a second after accepting it, so each
// poll looks back a little past the newest message already seen.
const OVERLAP_SECONDS = 5
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const CODE_SHAPE = /^[a-z2-9]{16}$/
// Messages one person sends within this many seconds draw as one block.
const GROUP_SECONDS = 300
// A notice that opens with this mark is drawn as a problem, not as a note.
const PROBLEM = '!'

const NO_PROFILE: Profile = { name: '', isMuted: false }

const profile = atom({ plugin: 'side-chat', key: 'profile' } as const, NO_PROFILE, {
  shape: 'profile-1',
})
const chats = atom({ plugin: 'side-chat', key: 'chats' } as const, [], {
  shape: 'chats-1',
})
const messages = atom({ plugin: 'side-chat', key: 'messages' } as const, [], {
  shape: 'messages-2',
})
// The chat this session shows; empty for the list of chats.
const open = atom({ plugin: 'side-chat', key: 'open' } as const, '')
const notice = atom({ plugin: 'side-chat', key: 'notice' } as const, '')
const sent = atom({ plugin: 'side-chat', key: 'sent' } as const, 0)
const isLeaving = atom({ plugin: 'side-chat', key: 'isLeaving' } as const, false)
// Which page the pane shows beside the list and a chat: '' for those two,
// or 'details', 'add', 'settings'.
const page = atom({ plugin: 'side-chat', key: 'page' } as const, '')
// The clock, to the minute: writing it redraws the ages beside the messages.
const minute = atom({ plugin: 'side-chat', key: 'minute' } as const, 0)
// The newest unseen message, drawn in the row above the prompt.
const alert = atom({ plugin: 'side-chat', key: 'alert' } as const, null)
// How messages reach this machine right now: 'live', 'poll' or '' (unknown).
const transport = atom({ plugin: 'side-chat', key: 'transport' } as const, '')

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

const oneLine = (value: string, max: number): string =>
  cut(value.replace(/\s+/g, ' '), max)

const dashed = (code: string): string =>
  code.replace(/(.{4})(?=.)/g, '$1-')

/** The code with its middle hidden: it is a secret, and the pane stays open. */
const mask = (code: string): string =>
  `${code.slice(0, 4)}-····-····-${code.slice(-4)}`

function ago(nowMs: number, timeSeconds: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - timeSeconds)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`

  return `${Math.floor(seconds / 86400)}d`
}

/** A new invite code: 16 letters drawn evenly from the alphabet, about 79 bits. */
function newCode(): string {
  const letters: string[] = []
  // Bytes past the last whole multiple of the alphabet are thrown away, so
  // every letter is equally likely.
  const limit = 256 - (256 % CODE_ALPHABET.length)

  while (letters.length < 16) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      const letter = CODE_ALPHABET[byte % CODE_ALPHABET.length]
      if (byte < limit && letter !== undefined && letters.length < 16) letters.push(letter)
    }
  }

  return letters.join('')
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
      typeof one.text === 'string' &&
      typeof one.nonce === 'string',
  )
}

function asContacts(value: unknown): Contact[] {
  if (!Array.isArray(value)) return []

  return value.filter(
    (one): one is Contact =>
      typeof one === 'object' &&
      one !== null &&
      typeof one.id === 'string' &&
      typeof one.label === 'string' &&
      typeof one.code === 'string' &&
      typeof one.key === 'string' &&
      typeof one.topic === 'string' &&
      typeof one.me === 'string',
  )
}

const logKey = (id: string): string => `log:${id}`

const loadContacts = async ($: Engine): Promise<Contact[]> =>
  asContacts(await $.store.get('contacts'))

type Row = { id: string; time: number; topic: string; body: string }

/** Reads the relay's answer: one JSON event per line, a sealed frame inside. */
function parseRows(body: string): Row[] {
  const rows: Row[] = []

  for (const line of body.split('\n')) {
    if (line.trim() === '') continue

    try {
      const row = JSON.parse(line)

      if (
        row?.event === 'message' &&
        typeof row.id === 'string' &&
        typeof row.topic === 'string' &&
        typeof row.message === 'string'
      ) {
        rows.push({
          id: row.id,
          time: Number(row.time) || 0,
          topic: row.topic,
          body: row.message,
        })
      }
    } catch {
      // A cut line: the next poll asks again.
    }
  }

  return rows
}

/** Opens a relay row with its chat's key; null for anything not sealed for it. */
function readRow(contact: Contact, row: Row): ChatMessage | null {
  const opened = openFrame(contact, row.body)
  if (opened === null) return null
  const { payload, nonce } = opened
  if (Math.abs(row.time * 1000 - payload.ts) > MAX_SKEW_MS) return null
  const text = clean(payload.text, 4000)
  if (text === '') return null

  return {
    id: row.id,
    time: row.time,
    from: clean(payload.from, 40) || 'Friend',
    cid: payload.cid.slice(0, 80),
    text,
    nonce,
  }
}

function merge(log: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(log.map(one => [one.id, one]))
  // A frame the relay hands over twice under two ids is one message.
  const nonces = new Set(log.map(one => one.nonce))

  for (const one of incoming) {
    if (byId.has(one.id) || nonces.has(one.nonce)) continue
    byId.set(one.id, one)
    nonces.add(one.nonce)
  }

  return [...byId.values()]
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
    .slice(-KEEP)
}

// Writes to the store are read, change, write: two at once would lose one.
// Everything that files messages or copies them into state runs in turn.
let turn: Promise<unknown> = Promise.resolve()

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = turn.then(work, work)
  turn = run.catch(() => undefined)

  return run
}

/** Counts a request against the relay's allowance and answers what is left. */
async function budget($: Engine, now: number, cost: number): Promise<number> {
  const held = (await $.store.get('budget')) as { tokens?: unknown; at?: unknown } | null
  const tokens = typeof held?.tokens === 'number' ? held.tokens : BUDGET_START
  const at = typeof held?.at === 'number' ? held.at : now
  const left = Math.min(BUDGET_MAX, tokens + Math.max(0, now - at) / REFILL_MS) - cost
  if (cost !== 0) await $.store.set('budget', { tokens: left, at: now })

  return left
}

/**
 * A notification from the system itself, which shows whether or not Claude
 * is in front. The text goes after `--`, so nothing a friend writes is ever
 * read as an option or a script. Answers how it went out, for the test row.
 */
async function popup($: Engine, title: string, line: string): Promise<string> {
  let argv: string[] | null = null

  try {
    const { sysname } = await $.session.machine()

    if (sysname === 'Darwin') {
      argv = [
        'osascript',
        '-e',
        'on run argv',
        '-e',
        'display notification (item 1 of argv) with title (item 2 of argv) subtitle "Friend chat"',
        '-e',
        'end run',
        '--',
        line,
        title,
      ]
    } else if (sysname === 'Linux') {
      argv = ['notify-send', '--app-name=Friend chat', '--', title, line]
    }

    if (argv !== null) {
      const ran = await $.process.run(argv, { timeoutMs: 5000 })
      if (ran.exitCode === 0) return 'system'
    }
  } catch {
    // No commands on this surface, or no notifier: Claude's own channel next.
  }

  try {
    const raised = await $.ui.notify(line, { title, key: 'message' })

    return raised.isSent ? `claude (${raised.channel})` : `none (${raised.reason})`
  } catch {
    return 'none (refused)'
  }
}

async function say($: Engine, text: string): Promise<void> {
  if ((await read($, notice)) !== text) await update($, notice, () => text)
}

/**
 * A chat saved by the first version of this mod was one plain code. It
 * becomes the first saved chat, sealed from here on: the code is the same,
 * the topic is new, so both people need this version.
 */
async function migrate($: Engine): Promise<void> {
  const legacy = normalizeCode(asText(await $.store.get('room')))
  if (legacy === '') return

  if (CODE_SHAPE.test(legacy)) {
    const contacts = await loadContacts($)

    if (!contacts.some(one => one.code === legacy)) {
      contacts.push({
        id: crypto.randomUUID().slice(0, 8),
        label: '',
        code: legacy,
        ...deriveKeys(legacy),
        me: crypto.randomUUID(),
      })
      await $.store.set('contacts', contacts)
    }
  }

  await $.store.delete('room')
  await $.store.delete('log')
  await $.store.delete('cursor')
  await $.store.delete('clientId')
}

/**
 * Copies what the store holds into this session's state, and tells the
 * person what is new since the last copy: a toast in each open session, and
 * one native notification for the machine, claimed through the shared store.
 */
const sync = ($: Engine): Promise<void> => inTurn(() => syncNow($))

async function syncNow($: Engine): Promise<void> {
  const contacts = await loadContacts($)
  const stored: Profile = {
    name: asText(await $.store.get('name')),
    isMuted: (await $.store.get('muted')) === true,
  }
  const held = await read($, profile)

  if (held.name !== stored.name || held.isMuted !== stored.isMuted) {
    await update($, profile, () => stored)
  }

  let openId = await read($, open)

  if (openId !== '' && !contacts.some(one => one.id === openId)) {
    openId = ''
    await update($, open, () => '')
  }

  const before = await read($, chats)
  const after: ChatSummary[] = []
  const news: { id: string; label: string; fresh: ChatMessage[] }[] = []
  let shown: ChatMessage[] = []

  for (const contact of contacts) {
    const log = asLog(await $.store.get(logKey(contact.id)))
    if (contact.id === openId) shown = log
    const known = before.find(one => one.id === contact.id)
    const last = log[log.length - 1]
    const seenAt = known === undefined ? -1 : log.findIndex(one => one.id === known.seen)
    // New to this session: everything after the last message it knew. A chat
    // it has not drawn yet (a new session, a chat just joined) starts quiet.
    const fresh =
      known === undefined || (known.seen !== '' && seenAt === -1)
        ? []
        : log.slice(seenAt + 1).filter(one => one.cid !== contact.me)
    const friend = log.findLast(one => one.cid !== contact.me)?.from
    // The name the person gave the contact; until then, the name the friend
    // writes under.
    const named = contact.label === 'New chat' ? '' : contact.label
    const label = named !== '' ? named : (friend ?? 'New chat')
    if (fresh.length > 0) news.push({ id: contact.id, label, fresh })
    after.push({
      id: contact.id,
      label,
      mask: mask(contact.code),
      me: contact.me,
      preview:
        last === undefined
          ? ''
          : oneLine(`${last.cid === contact.me ? 'You' : last.from}: ${last.text}`, 80),
      time: last?.time ?? 0,
      unread: (known?.unread ?? 0) + fresh.length,
      seen: last?.id ?? '',
    })
  }

  after.sort((a, b) => b.time - a.time)

  if (JSON.stringify(after) !== JSON.stringify(before)) {
    await update($, chats, () => after)
  }

  const drawn = await read($, messages)

  if (
    drawn.length !== shown.length ||
    drawn[drawn.length - 1]?.id !== shown[shown.length - 1]?.id ||
    drawn[0]?.id !== shown[0]?.id
  ) {
    await update($, messages, () => shown)
  }

  if (news.length === 0) return
  // A reply is likely soon: ask the relay more often for a while.
  await $.store.set('activeAt', await $.clock.now())
  if (stored.isMuted) return

  for (const { id, label, fresh } of news) {
    const last = fresh[fresh.length - 1]
    if (last === undefined) continue
    const line = oneLine(last.text, 140)
    // In Claude: the row above the prompt, and a toast where one is drawn.
    const at = await $.clock.now()
    await update($, alert, (): Alert => ({ chat: id, from: label, text: line, count: fresh.length, at }))
    $.ui.toast(`${last.from}: ${line}`, { timeoutMs: 8000 })
    // Out of Claude: one system notification for the machine, whichever
    // session saw the message first.
    if (asText(await $.store.get('notified')) === last.id) continue
    await $.store.set('notified', last.id)
    const how = await popup(
      $,
      fresh.length > 1 ? `${label} (${fresh.length} new messages)` : label,
      line,
    )
    await $.store.set('lastPopup', how)
  }
}

async function clearAlert($: Engine): Promise<void> {
  if ((await read($, alert)) !== null) await update($, alert, () => null)
}

let backoffUntil = 0

/** Files what the relay handed over under each chat it opens for. */
function fileRows($: Engine, contacts: Contact[], rows: Row[]): Promise<void> {
  return inTurn(async () => {
    if (rows.length === 0) return

    for (const contact of contacts) {
      const incoming = rows
        .filter(row => row.topic === contact.topic)
        .map(row => readRow(contact, row))
        .filter(one => one !== null)
      if (incoming.length === 0) continue
      const log = asLog(await $.store.get(logKey(contact.id)))
      const merged = merge(log, incoming)
      if (merged.length !== log.length) await $.store.set(logKey(contact.id), merged)
    }

    const newest = Math.max(0, ...rows.map(row => row.time))
    const marked = Number(await $.store.get('since')) || 0
    if (newest > marked) await $.store.set('since', newest)
  })
}

const sinceMark = async ($: Engine): Promise<string> => {
  const marked = Number(await $.store.get('since')) || 0

  return marked === 0 ? '12h' : String(marked - OVERLAP_SECONDS)
}

// ---- The live stream: one `curl` held open on the relay, so a message
// arrives as it is posted. It needs a surface that runs commands and a curl
// on the PATH; where either is missing, polling carries on alone.
const SESSION = crypto.randomUUID()
let canStream = true
let streamTopics = ''
let streamRun = 0
let streamHeardAt = -1
let streamRetryAt = 0
let streamFails = 0
let streamChild: AsyncGenerator<unknown, unknown> | null = null

const streamIsLive = (): boolean =>
  streamTopics !== '' &&
  streamHeardAt >= 0 &&
  performance.now() - streamHeardAt < STREAM_QUIET_MS

function stopStream(): void {
  streamRun += 1
  streamTopics = ''
  streamHeardAt = -1
  const child = streamChild
  streamChild = null
  // Ending the stream is what ends the child.
  if (child !== null) void child.return(undefined).catch(() => undefined)
}

async function runStream($: Engine, topics: string): Promise<void> {
  streamRun += 1
  const run = streamRun
  streamTopics = topics
  streamHeardAt = -1
  const startedAt = performance.now()
  let buffer = ''

  try {
    await budget($, await $.clock.now(), 1)
    const child = $.process.spawn({
      argv: [
        'curl',
        '-sN',
        '--fail',
        '--connect-timeout',
        '10',
        // Give up on a connection that has gone silent, keepalives included.
        '--speed-limit',
        '1',
        '--speed-time',
        String(STREAM_QUIET_MS / 1000),
        '--max-time',
        String(STREAM_MAX_SECONDS),
        `${SERVER}/${topics}/json?since=${await sinceMark($)}`,
      ],
    })
    streamChild = child

    for await (const piece of child) {
      if (run !== streamRun) break
      if (piece.stream !== 'stdout') continue
      streamHeardAt = performance.now()
      buffer += piece.text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      const rows = parseRows(lines.join('\n'))
      if (rows.length === 0) continue
      await fileRows($, await loadContacts($), rows)
      await sync($)
    }

    // A connection that held is no failure: curl ends each one on schedule.
    streamFails = performance.now() - startedAt > 30000 ? 0 : streamFails + 1
  } catch {
    streamFails += 1
    // It never said a word, twice: this surface runs no commands, or has no
    // curl. Polling takes over for good.
    if (streamHeardAt < 0 && streamFails >= 2) canStream = false
  } finally {
    if (run === streamRun) {
      streamTopics = ''
      streamChild = null
      streamRetryAt = performance.now() + Math.min(60000, 2000 * 2 ** streamFails)
    }
  }
}

/** Keeps one live stream per machine on the chats' topics. */
async function ensureStream($: Engine, contacts: Contact[], now: number): Promise<boolean> {
  const held = (await $.store.get('stream')) as
    | { owner?: unknown; at?: unknown; isLive?: unknown }
    | null
  const heldAt = typeof held?.at === 'number' ? held.at : 0
  const isOthers = held?.owner !== SESSION && now - heldAt < LEASE_MS
  const topics = contacts.map(one => one.topic).join(',')

  if (!canStream || isOthers || topics === '') {
    if (streamTopics !== '') stopStream()

    return isOthers && held?.isLive === true
  }

  const isLive = streamIsLive()

  if (held?.owner !== SESSION || now - heldAt >= HEARTBEAT_MS || held.isLive !== isLive) {
    await $.store.set('stream', { owner: SESSION, at: now, isLive })
  }

  if (streamTopics !== topics && performance.now() >= streamRetryAt) {
    if (streamTopics !== '') stopStream()
    void runStream($, topics)
  }

  return isLive
}

/**
 * Asks the relay what arrived on these chats' topics, in one request, and
 * files what opens under each chat. `since` is what the relay takes: a
 * duration, or a time in seconds.
 */
async function poll($: Engine, contacts: Contact[], since: string): Promise<void> {
  if (contacts.length === 0) return
  const topics = contacts.map(one => one.topic).join(',')

  try {
    const answer = await $.http.fetch(`${SERVER}/${topics}/json?poll=1&since=${since}`)

    if (answer.status === 429) {
      const now = await $.clock.now()
      backoffUntil = now + BACKOFF_MS
      // The estimate was too hopeful: start over from empty.
      await $.store.set('budget', { tokens: 0, at: now })
      await say($, `${PROBLEM}The relay asked to slow down. Trying again in a minute.`)

      return
    }

    if (!answer.ok) {
      await say($, `${PROBLEM}Could not check for messages (relay said ${answer.status}).`)

      return
    }

    await fileRows($, contacts, parseRows(answer.text))
    await say($, '')
  } catch {
    await say($, `${PROBLEM}Could not reach the relay. Still trying.`)
  }
}

let busySince = -1

/**
 * One round: every open session on this machine ticks, and they share one
 * poll through the store, so the relay hears from the machine once a period.
 */
async function tick($: Engine, isForced = false): Promise<void> {
  // A request that never answers must not stop this session for good.
  if (busySince >= 0 && performance.now() - busySince < STUCK_MS) return
  busySince = performance.now()

  try {
    await migrate($)
    const now = await $.clock.now()
    const thisMinute = Math.floor(now / 60000)

    if ((await read($, minute)) !== thisMinute) {
      await update($, minute, () => thisMinute)
    }

    // The row above the prompt does not outstay its message.
    const shown = await read($, alert)
    if (shown !== null && !(now - shown.at <= ALERT_MS)) await clearAlert($)

    const contacts = await loadContacts($)
    const isLive = await ensureStream($, contacts, now)
    const mode = contacts.length === 0 ? '' : isLive ? 'live' : 'poll'
    if ((await read($, transport)) !== mode) await update($, transport, () => mode)

    if (contacts.length > 0) {
      const polledAt = Number(await $.store.get('polledAt')) || 0
      const activeAt = Number(await $.store.get('activeAt')) || 0
      const every = isLive
        ? POLL_SAFETY_MS
        : now - activeAt >= HOT_WINDOW_MS
          ? POLL_IDLE_MS
          : (await budget($, now, 0)) > BUDGET_LOW
            ? POLL_HOT_MS
            : POLL_LOW_MS
      const isDue = now - polledAt >= every && now >= backoffUntil

      if (isForced || isDue) {
        await $.store.set('polledAt', now)
        await budget($, now, 1)
        await poll($, contacts, await sinceMark($))
      }
    }

    await sync($)
  } finally {
    busySince = -1
  }
}

async function saveName($: Engine, value: string): Promise<void> {
  const name = clean(value, 40)

  if (name === '') {
    await say($, `${PROBLEM}Type a name first.`)

    return
  }

  const isFirst = asText(await $.store.get('name')) === ''
  await $.store.set('name', name)
  await sync($)
  await say($, isFirst ? '' : 'Saved.')
}

/** Moves the pane to one of its pages, with a clean slate. */
async function goTo($: Engine, where: string): Promise<void> {
  await update($, isLeaving, () => false)
  await say($, '')
  await update($, page, () => where)
}

/** A round badge with the contact's initial, for surfaces that draw pictures. */
function avatar(name: string): string {
  const first = name.trim()[0] ?? ''
  const letter = /[a-z0-9]/i.test(first) ? first.toUpperCase() : '•'
  let hue = 0
  for (const one of name) hue = (hue * 31 + (one.codePointAt(0) ?? 0)) % 360

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">' +
    `<circle cx="14" cy="14" r="14" fill="hsl(${hue} 32% 52%)"/>` +
    '<text x="14" y="19" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" ' +
    `font-size="14" font-weight="600" fill="#fff">${letter}</text></svg>`
  )
}

async function clearUnread($: Engine, id: string): Promise<void> {
  if ((await read($, alert))?.chat === id) await clearAlert($)
  const list = await read($, chats)

  if (list.some(one => one.id === id && one.unread !== 0)) {
    await update($, chats, held =>
      held.map(one => (one.id === id ? { ...one, unread: 0 } : one)),
    )
  }
}

async function showChat($: Engine, id: string): Promise<void> {
  // What was on screen in the chat being left has been seen.
  const leaving = await read($, open)
  if (leaving !== '' && leaving !== id) await clearUnread($, leaving)
  await update($, open, () => id)
  await update($, isLeaving, () => false)
  await update($, page, () => '')
  await say($, '')
  if (id !== '') await $.store.set('lastOpen', id)
  await sync($)
  if (id !== '') await clearUnread($, id)
}

/** Saves a chat by its invite code, or opens it when it is saved already. */
async function addChat($: Engine, value: string): Promise<void> {
  const code = normalizeCode(value)

  if (!CODE_SHAPE.test(code)) {
    await say($, `${PROBLEM}That does not look like an invite code (xxxx-xxxx-xxxx-xxxx).`)

    return
  }

  const contacts = await loadContacts($)
  const saved = contacts.find(one => one.code === code)

  if (saved !== undefined) {
    await showChat($, saved.id)

    return
  }

  if (contacts.length >= MAX_CONTACTS) {
    await say($, `${PROBLEM}That is ${MAX_CONTACTS} chats. Remove one to add another.`)

    return
  }

  const contact: Contact = {
    id: crypto.randomUUID().slice(0, 8),
    label: '',
    code,
    // The slow step: done once here, and the key is kept with the chat.
    ...deriveKeys(code),
    me: crypto.randomUUID(),
  }
  await $.store.set('contacts', [...contacts, contact])
  await showChat($, contact.id)
  // What the other person sent before this machine joined, if still kept.
  await poll($, [contact], '12h')
  await sync($)
}

/** Saves the person's own name for a contact; empty goes back to the friend's. */
async function renameChat($: Engine, id: string, value: string): Promise<void> {
  const label = clean(value, 40)
  const contacts = await loadContacts($)
  await $.store.set(
    'contacts',
    contacts.map(one => (one.id === id ? { ...one, label } : one)),
  )
  await sync($)
  await say($, 'Saved.')
}

async function removeChat($: Engine, id: string): Promise<void> {
  const contacts = await loadContacts($)
  await $.store.set(
    'contacts',
    contacts.filter(one => one.id !== id),
  )
  await $.store.delete(logKey(id))
  await showChat($, '')
}

async function setMuted($: Engine, isMuted: boolean): Promise<void> {
  await $.store.set('muted', isMuted)
  await sync($)
  await say(
    $,
    isMuted
      ? 'Muted: no popups for new messages.'
      : 'Popups are on for new messages.',
  )
}

/** The person is writing: clear what they have now seen, and expect a reply. */
async function typing($: Engine, id: string): Promise<void> {
  await clearUnread($, id)
  const now = await $.clock.now()
  const activeAt = Number(await $.store.get('activeAt')) || 0
  if (now - activeAt > 20000) await $.store.set('activeAt', now)
}

/** Raises every kind of popup once, and says in the pane how each went. */
async function testPopups($: Engine): Promise<void> {
  const text = 'This is a test popup.'
  const at = await $.clock.now()
  await update($, alert, (): Alert => ({ chat: '', from: TITLE, text, count: 1, at }))
  $.ui.toast(`${TITLE}: ${text}`, { timeoutMs: 8000 })
  const how = await popup($, TITLE, text)
  await $.store.set('lastPopup', how)
  await say(
    $,
    how === 'system'
      ? 'Test sent: a row above the prompt, and a system notification.'
      : how.startsWith('claude')
        ? `Test sent: a row above the prompt, and a notification through ${how}.`
        : `${PROBLEM}Only the row above the prompt could be shown here: ${how}.`,
  )
}

async function copyCode($: Engine, id: string, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile'): Promise<void> {
  const contact = (await loadContacts($)).find(one => one.id === id)
  if (contact === undefined) return
  const code = dashed(contact.code)
  const copied = await $.ui.copy({ text: code, surface })
  await say(
    $,
    copied.isCopied
      ? 'Invite code copied. Send it to your friend privately.'
      : `${PROBLEM}Could not copy. Your code is ${code}`,
  )
}

async function send($: Engine, id: string, value: string): Promise<void> {
  const text = clean(value, 4000)
  if (text === '') return
  const contact = (await loadContacts($)).find(one => one.id === id)
  if (contact === undefined) return
  const name = asText(await $.store.get('name')) || 'Friend'
  const frame = seal(contact, {
    from: name,
    cid: contact.me,
    ts: await $.clock.now(),
    text,
  })

  if (frame === null) {
    await say($, `${PROBLEM}That message is too long to send. Split it in two.`)

    return
  }

  try {
    const answer = await $.http.fetch(`${SERVER}/${contact.topic}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: frame,
    })

    if (!answer.ok) {
      await say($, `${PROBLEM}Not sent (relay said ${answer.status}). Try again.`)

      return
    }

    const now = await $.clock.now()
    await budget($, now, 1)
    await $.store.set('activeAt', now)
    await fileRows($, [contact], parseRows(answer.text))
    // A new key gives an empty field for the next message.
    await update($, sent, count => count + 1)
    await say($, '')
    await sync($)
    await clearUnread($, id)
  } catch {
    await say($, `${PROBLEM}Not sent: could not reach the relay. Try again.`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'friend',
      description: 'Open the chat pane to message your friends (/friend close closes it)',
    })
    await migrate($)
    const startedAt = Math.floor((await $.clock.now()) / 60000)
    await update($, minute, () => startedAt)
    const contacts = await loadContacts($)

    // A session opens on the chat last looked at; with one chat, on that one.
    if ((await read($, open)) === '') {
      const lastOpen = asText(await $.store.get('lastOpen'))
      const first =
        contacts.find(one => one.id === lastOpen) ??
        (contacts.length === 1 ? contacts[0] : undefined)
      if (first !== undefined) await update($, open, () => first.id)
    }

    await sync($)

    // The pane opens by itself only for the first-run setup. After that it is
    // the person's to open (`/friend`, or "Open" on the row above the prompt)
    // and to close: a pane this mod reopened or pinned small could not be
    // closed for good.
    if (asText(await $.store.get('name')) === '') {
      void $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true })
    }

    $.clock.every(TICK_MS, () => {
      void tick($)
    })

    return next(e)
  })

  on('command.run', { command: 'friend' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'Friend chat closed.' }
    }

    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
    const openId = await read($, open)
    if (openId !== '') await clearUnread($, openId)
    void tick($, true)

    return { text: 'Friend chat opened.' }
  })

  // The popup inside Claude: a row above the prompt for the newest unseen
  // message, until it is opened, dismissed or answered.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const held = await read($, alert)
    if (held === null || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box gap={1} alignItems="center">
        <Text weight="semibold">
          {held.from}
          {held.count > 1 ? ` (${held.count} new)` : ''}
        </Text>
        <Text dimColor wrap="truncate-end">
          {held.text}
        </Text>
        <Button
          key="alert-open"
          variant="primary"
          label="Open"
          onPress={async () => {
            await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
            if (held.chat !== '') await showChat($, held.chat)
            await clearAlert($)
          }}
        />
        <Button key="alert-dismiss" label="Close" onPress={() => clearAlert($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Input, Text } = table
    const Svg = 'Svg' in table ? table.Svg : null
    const who = await read($, profile)
    const list = await read($, chats)
    const openId = await read($, open)
    const log = await read($, messages)
    const note = await read($, notice)
    const count = await read($, sent)
    const leaving = await read($, isLeaving)
    const where = await read($, page)
    const mode = await read($, transport)
    const nowMs = (await read($, minute)) * 60000
    const chat = list.find(one => one.id === openId)
    const unread = list.reduce((sum, one) => sum + one.unread, 0)

    // The small form on the desktop app: read at a glance, no controls.
    if (e.props.placement === 'widget') {
      const latest = list[0]
      const glance =
        latest === undefined
          ? 'Open to set up'
          : latest.preview === ''
            ? 'No messages yet'
            : latest.preview

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between" gap={1}>
            <Text weight="semibold">
              {latest === undefined || list.length > 1 ? TITLE : latest.label}
            </Text>
            {unread > 0 && (
              <Text color="claude" size="caption">
                {`${unread} new`}
              </Text>
            )}
          </Box>
          <Text dimColor maxLines={2}>
            {glance}
          </Text>
        </Box>
      )
    }

    // ---- Pieces every page is built from.

    const face = (name: string) =>
      Svg === null ? null : <Svg source={avatar(name)} alt="" width={28} height={28} />

    /** The top of a page: where you came from, where you are, the way out. */
    const bar = (title: string, back: (() => Promise<unknown>) | null, extra: RenderChildren = null) => (
      <Box justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
        <Box gap={1} alignItems="center">
          {back !== null && <Button key="back" label="‹ Back" onPress={back} />}
          <Text size="heading" weight="semibold">
            {title}
          </Text>
        </Box>
        <Box gap={1} alignItems="center">
          {extra}
          <Button key="close" label="Close" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )

    /** A titled group of controls. */
    const section = (title: string, hint: string, body: RenderChildren) => (
      <Box
        flexDirection="column"
        gap={1}
        borderStyle="round"
        borderColor="promptBorder"
        paddingX={1}
      >
        <Box flexDirection="column">
          <Text weight="semibold">{title}</Text>
          {hint !== '' && (
            <Text dimColor size="footnote">
              {hint}
            </Text>
          )}
        </Box>
        {body}
      </Box>
    )

    const isProblem = note.startsWith(PROBLEM)
    const status =
      note === '' ? null : (
        <Text size="footnote" dimColor={!isProblem} color={isProblem ? 'warning' : undefined}>
          {isProblem ? note.slice(PROBLEM.length) : note}
        </Text>
      )
    const privacy = (
      <Text dimColor size="caption">
        End-to-end encrypted. Claude can't see your chats.
      </Text>
    )

    const starting = section(
      'Start a new chat',
      'Makes an invite code to send to your friend.',
      <Box>
        <Button
          key="create"
          variant="primary"
          label="Create invite code"
          onPress={() => addChat($, newCode())}
        />
      </Box>,
    )
    const joining = section(
      'Join a friend',
      'Paste the invite code they sent you.',
      <Input
        key="join"
        placeholder="xxxx-xxxx-xxxx-xxxx"
        submitLabel="Join"
        onSubmit={value => addChat($, value)}
      />,
    )

    // ---- Welcome: the first run.
    if (who.name === '') {
      return (
        <Box flexDirection="column" gap={1}>
          {bar(TITLE, null)}
          <Text dimColor>
            Message your friends from here while you work. They need this mod
            too.
          </Text>
          {section(
            'What should friends call you?',
            'Shown beside your messages. You can change it later.',
            <Input
              key="name"
              placeholder="Your name"
              submitLabel="Continue"
              autoFocus
              onSubmit={value => saveName($, value)}
            />,
          )}
          {status}
          {privacy}
        </Box>
      )
    }

    // ---- Settings.
    if (where === 'settings') {
      return (
        <Box flexDirection="column" gap={1}>
          {bar('Settings', () => goTo($, ''))}
          {section(
            'Your name',
            'Shown beside your messages.',
            <Input
              key="name"
              value={who.name}
              placeholder="Your name"
              submitLabel="Save"
              onSubmit={value => saveName($, value)}
            />,
          )}
          {section(
            who.isMuted ? 'Popups are off' : 'Popups are on',
            'A new message shows above the prompt and as a system notification.',
            <Box gap={1} flexWrap="wrap">
              <Button
                key="mute"
                label={who.isMuted ? 'Turn popups on' : 'Turn popups off'}
                onPress={() => setMuted($, !who.isMuted)}
              />
              <Button key="test" label="Send a test popup" onPress={() => testPopups($)} />
            </Box>,
          )}
          {status}
          {privacy}
        </Box>
      )
    }

    // ---- Add a chat.
    if (where === 'add' && chat === undefined) {
      return (
        <Box flexDirection="column" gap={1}>
          {bar('New chat', () => goTo($, ''))}
          {starting}
          {joining}
          {status}
          <Text dimColor size="caption">
            Anyone with a chat's code can read it, so share codes privately.
          </Text>
        </Box>
      )
    }

    // ---- Contacts: the home page.
    if (chat === undefined) {
      return (
        <Box flexDirection="column" gap={1}>
          {bar(
            list.length === 0 ? `Hi ${who.name}` : 'Messages',
            null,
            <Button key="settings" label="Settings" onPress={() => goTo($, 'settings')} />,
          )}
          {list.length === 0 && (
            <Text dimColor>
              No chats yet. Start one, or join a friend's. Either way it is
              saved here as a contact.
            </Text>
          )}
          {list.length === 0 && starting}
          {list.length === 0 && joining}
          {list.map(one => (
            <Box
              borderStyle="round"
              borderColor="promptBorder"
              paddingX={1}
              justifyContent="space-between"
              alignItems="center"
              gap={1}
            >
              <Box gap={1} alignItems="center" flexGrow={1} flexShrink={1}>
                {face(one.label)}
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Box gap={1} alignItems="center">
                    <Text weight="semibold">{one.label}</Text>
                    {one.unread > 0 && (
                      <Text color="claude" size="caption">
                        {`● ${one.unread} new`}
                      </Text>
                    )}
                    <Text dimColor size="caption">
                      {one.time === 0 || nowMs === 0 ? '' : ago(nowMs, one.time)}
                    </Text>
                  </Box>
                  <Text dimColor maxLines={1}>
                    {one.preview === '' ? 'No messages yet' : one.preview}
                  </Text>
                </Box>
              </Box>
              <Button
                key={`chat-${one.id}`}
                variant={one.unread > 0 ? 'primary' : 'secondary'}
                label="Open"
                onPress={() => showChat($, one.id)}
              />
            </Box>
          ))}
          {list.length > 0 && (
            <Box>
              <Button
                key="new"
                variant="primary"
                label="New chat"
                onPress={() => goTo($, 'add')}
              />
            </Box>
          )}
          {status}
          {privacy}
        </Box>
      )
    }

    const isMine = (one: ChatMessage): boolean => one.cid === chat.me
    const hasFriend = log.some(one => !isMine(one))
    const isNamed = chat.label !== 'New chat'
    const copy = (
      <Button
        key="copy"
        variant={hasFriend ? 'secondary' : 'primary'}
        label="Copy invite code"
        onPress={() => copyCode($, chat.id, e.surface)}
      />
    )

    // ---- Contact details.
    if (where === 'details') {
      return (
        <Box flexDirection="column" gap={1}>
          {bar('Contact', () => goTo($, ''))}
          {section(
            'Name',
            'Only you see this. Leave it empty to use the name they write under.',
            <Input
              key="rename"
              value={isNamed ? chat.label : ''}
              placeholder="A name for this contact"
              submitLabel="Save"
              onSubmit={value => renameChat($, chat.id, value)}
            />,
          )}
          {section(
            'Invite code',
            'Whoever has this code can join and read the chat.',
            <Box gap={1} alignItems="center" flexWrap="wrap">
              <Text mono>{chat.mask}</Text>
              {copy}
            </Box>,
          )}
          {section(
            'Remove contact',
            'Forgets the chat and its messages on this computer.',
            leaving ? (
              <Box gap={1} alignItems="center" flexWrap="wrap">
                <Text>Remove {chat.label}?</Text>
                <Button
                  key="leave-yes"
                  variant="primary"
                  label="Yes, remove"
                  onPress={() => removeChat($, chat.id)}
                />
                <Button
                  key="leave-no"
                  label="Keep"
                  onPress={() => update($, isLeaving, () => false)}
                />
              </Box>
            ) : (
              <Box>
                <Button
                  key="leave"
                  label="Remove contact"
                  onPress={() => update($, isLeaving, () => true)}
                />
              </Box>
            ),
          )}
          {status}
        </Box>
      )
    }

    // ---- A chat.

    // Newest messages that fit the pane, counted by the rows they wrap to.
    const columns = Math.max(16, e.props.bodyColumns - 6)
    const room = Math.max(8, e.props.scroll.bodyRows - 9)
    const shown: ChatMessage[] = []
    let used = 0

    for (let at = log.length - 1; at >= 0; at -= 1) {
      const one = log[at]
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
    const groups: { isMine: boolean; from: string; items: ChatMessage[] }[] = []

    for (const one of shown) {
      const last = groups[groups.length - 1]
      const closes = last?.items[last.items.length - 1]

      if (
        last !== undefined &&
        closes !== undefined &&
        last.isMine === isMine(one) &&
        last.from === one.from &&
        one.time - closes.time < GROUP_SECONDS
      ) {
        last.items.push(one)
      } else {
        groups.push({ isMine: isMine(one), from: one.from, items: [one] })
      }
    }

    const hidden = log.length - shown.length
    const when = (group: { items: ChatMessage[] }): string => {
      const newest = group.items[group.items.length - 1]

      return newest === undefined || nowMs === 0 ? '' : ago(nowMs, newest.time)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {bar(
            hasFriend || isNamed ? chat.label : 'New chat',
            () => showChat($, ''),
            <Button key="details" label="Details" onPress={() => goTo($, 'details')} />,
          )}
          <Text dimColor size="caption">
            End-to-end encrypted{' · '}
            {mode === 'live' ? 'Live' : 'Checking every few seconds'}
          </Text>
        </Box>

        {!hasFriend &&
          section(
            'Invite your friend',
            'Send them this code privately. They join with it once, and the chat is saved for both of you.',
            <Box gap={1} alignItems="center" flexWrap="wrap">
              <Text mono>{chat.mask}</Text>
              {copy}
            </Box>,
          )}
        {hidden > 0 && (
          <Text dimColor size="caption">
            {`${hidden} earlier ${hidden === 1 ? 'message' : 'messages'}`}
          </Text>
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
            <Box gap={1} marginRight={4}>
              {face(chat.label)}
              <Box flexDirection="column" flexShrink={1}>
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
            </Box>
          ),
        )}

        <Box flexDirection="column">
          <Input
            key={`message-${count}`}
            placeholder={hasFriend || isNamed ? `Message ${chat.label}` : 'Write a message'}
            submitLabel="Send"
            autoFocus
            onInput={() => typing($, chat.id)}
            onSubmit={value => send($, chat.id, value)}
          />
          {status}
        </Box>
      </Box>
    )
  }).catch(($, e) => {
    // A build that refuses a prop used above still gets a readable pane.
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>Friend chat needs a newer Claude Code to draw.</Text>
  })
}
