#!/usr/bin/env bun
// A stand-in friend, for testing the mod without a second person.
//
//   bun scripts/test-friend.ts chats            list the saved chats
//   bun scripts/test-friend.ts measure [n]      send n messages (default 3) and
//                                               time how long the mod takes to
//                                               receive each, then report how
//                                               the popup went out
//   bun scripts/test-friend.ts send [text]      send one message
//   bun scripts/test-friend.ts listen           print what you send from the
//                                               pane, with how long it took
//
// Add `--chat <number>` when more than one chat is saved. The script reads the
// chat's key from the mod's own store on this computer, so no invite code is
// typed or printed. Make a chat just for testing ("Start a new chat"): what
// this sends goes to everyone in the chat.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { open, seal } from '../hooks/crypto'

const SERVER = 'https://ntfy.sh'
const STORE_DIR = join(homedir(), '.claude', 'plugins', 'store')
const ME = 'test-friend'

type Contact = { id: string; label: string; code: string; key: string; topic: string; me: string }
type Store = Record<string, unknown>

function storePath(): string {
  const files = readdirSync(STORE_DIR)
    .filter(name => name.startsWith('side-chat_') && name.endsWith('.json'))
    .map(name => join(STORE_DIR, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const newest = files[0]
  if (newest === undefined) throw new Error(`The mod has saved nothing yet (looked in ${STORE_DIR}).`)

  return newest
}

function readStore(): Store {
  const parsed = JSON.parse(readFileSync(storePath(), 'utf8')) as Store

  return (parsed.values as Store | undefined) ?? parsed
}

const mask = (code: string): string => `${code.slice(0, 4)}-····-····-${code.slice(-4)}`
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function pickChat(args: string[]): Contact {
  const contacts = (readStore().contacts as Contact[] | undefined) ?? []
  if (contacts.length === 0) throw new Error('No saved chats. Press "Start a new chat" in the pane first.')
  const flag = args.indexOf('--chat')
  const chosen = flag >= 0 ? Number(args[flag + 1]) : contacts.length === 1 ? 1 : 0
  const contact = contacts[chosen - 1]

  if (contact === undefined) {
    listChats()
    throw new Error('More than one chat is saved: add --chat <number>.')
  }

  console.log(`Using chat ${chosen}: ${contact.label} (${mask(contact.code)})`)

  return contact
}

function listChats(): void {
  const contacts = (readStore().contacts as Contact[] | undefined) ?? []
  contacts.forEach((one, at) => console.log(`${at + 1}. ${one.label} (${mask(one.code)})`))
  if (contacts.length === 0) console.log('No saved chats.')
}

async function post(contact: Contact, text: string): Promise<{ id: string; sentAt: number }> {
  const sentAt = Date.now()
  const frame = seal(contact, { from: 'Test friend', cid: ME, ts: sentAt, text })
  if (frame === null) throw new Error('That message is too long.')
  const answer = await fetch(`${SERVER}/${contact.topic}`, { method: 'POST', body: frame })
  if (!answer.ok) throw new Error(`The relay said ${answer.status}.`)
  const row = (await answer.json()) as { id: string }

  return { id: row.id, sentAt }
}

async function measure(contact: Contact, count: number): Promise<void> {
  const took: number[] = []

  for (let at = 1; at <= count; at += 1) {
    const { id, sentAt } = await post(contact, `Test message ${at} of ${count}`)
    let arrived = -1

    while (Date.now() - sentAt < 30000) {
      const log = (readStore()[`log:${contact.id}`] as { id: string }[] | undefined) ?? []

      if (log.some(one => one.id === id)) {
        arrived = Date.now() - sentAt
        break
      }

      await sleep(50)
    }

    console.log(
      arrived < 0
        ? `  message ${at}: not received within 30 s (is Claude open with the mod loaded?)`
        : `  message ${at}: received by the mod after ${(arrived / 1000).toFixed(1)} s`,
    )
    if (arrived >= 0) took.push(arrived)
    await sleep(4000)
  }

  const store = readStore()
  const stream = store.stream as { isLive?: boolean; at?: number } | undefined
  const isFresh = stream?.at !== undefined && Date.now() - stream.at < 15000
  console.log(`Delivery: ${isFresh && stream?.isLive === true ? 'live stream' : 'polling'}`)
  console.log(`Popup went out as: ${String(store.lastPopup ?? 'nothing recorded')}${store.muted === true ? ' (popups are muted)' : ''}`)

  if (took.length > 0) {
    const mean = took.reduce((sum, one) => sum + one, 0) / took.length
    console.log(`Average: ${(mean / 1000).toFixed(1)} s over ${took.length} of ${count}`)
  }
}

async function listen(contact: Contact): Promise<void> {
  console.log('Listening. Send a message from the pane; Ctrl+C to stop.')
  const answer = await fetch(`${SERVER}/${contact.topic}/json`)
  if (!answer.ok || answer.body === null) throw new Error(`The relay said ${answer.status}.`)
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const piece of answer.body) {
    buffer += decoder.decode(piece as Uint8Array, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.trim() === '') continue
      const row = JSON.parse(line) as { event?: string; message?: string }
      if (row.event !== 'message' || typeof row.message !== 'string') continue
      const opened = open(contact, row.message)

      if (opened === null) {
        console.log('  (something on the topic that this chat cannot open)')
      } else if (opened.payload.cid !== ME) {
        const took = ((Date.now() - opened.payload.ts) / 1000).toFixed(1)
        console.log(`  ${opened.payload.from}: ${opened.payload.text}   [reached the relay stream ${took} s after it was sent]`)
      }
    }
  }
}

const [command = 'chats', ...args] = process.argv.slice(2)

try {
  if (command === 'chats') listChats()
  else if (command === 'measure') await measure(pickChat(args), Number(args.find(one => /^\d+$/.test(one) && args[args.indexOf(one) - 1] !== '--chat')) || 3)
  else if (command === 'send') {
    const words = args.filter((one, at) => one !== '--chat' && args[at - 1] !== '--chat')
    await post(pickChat(args), words.join(' ') || 'Hello from the test friend')
    console.log('Sent.')
  } else if (command === 'listen') await listen(pickChat(args))
  else console.log('Commands: chats, measure [n], send [text], listen')
} catch (problem) {
  console.error(problem instanceof Error ? problem.message : String(problem))
  process.exit(1)
}
