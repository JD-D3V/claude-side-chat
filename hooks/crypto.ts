import { xchacha20poly1305 } from './vendor/noble-ciphers/chacha.js'
import { hkdf } from './vendor/noble-hashes/hkdf.js'
import { scrypt } from './vendor/noble-hashes/scrypt.js'
import { sha256 } from './vendor/noble-hashes/sha2.js'

// End-to-end encryption for one chat. Both people hold the same invite code.
// From it come two values that cannot be turned back into the code or into
// each other: a secret key, which never leaves the machine, and the name of
// the relay topic. The relay sees the topic and sealed frames, nothing else.

const VERSION = 2
const NONCE_BYTES = 24
const TAG_BYTES = 16
const HEAD_BYTES = 1 + NONCE_BYTES
// Every frame is a whole number of blocks, so its size says little about the
// length of the text: 192 bytes are exactly 256 characters of base64.
const BLOCK_BYTES = 192
// The relay turns a body over 4,096 characters into an attachment.
const MAX_BLOCKS = 15
const PAD_MARK = 0x80

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type ChatKeys = {
  /** The message key, as base64: 32 secret bytes. */
  key: string
  /** The relay topic: public, and no help in finding the key. */
  topic: string
}

export type Payload = { from: string; cid: string; ts: number; text: string }

export type Opened = { payload: Payload; nonce: string }

export const normalizeCode = (code: string): string =>
  code.toLowerCase().replace(/[^a-z0-9]/g, '')

export function toBase64(bytes: Uint8Array): string {
  let binary = ''

  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }

  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)

  return bytes
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * Derives the chat's key and topic from its invite code. The slow step
 * (scrypt) comes first, so that neither value is a quick way to test guesses
 * of the code; run it once when a chat is added and keep the result.
 */
export function deriveKeys(code: string): ChatKeys {
  const root = scrypt(
    encoder.encode(normalizeCode(code)),
    encoder.encode('sidechat/v2/scrypt'),
    { N: 2 ** 15, r: 8, p: 1, dkLen: 32 },
  )
  const key = hkdf(sha256, root, undefined, encoder.encode('sidechat/v2/msg-key'), 32)
  const topicId = hkdf(sha256, root, undefined, encoder.encode('sidechat/v2/topic'), 16)

  return { key: toBase64(key), topic: `sc2-${toHex(topicId)}` }
}

// Binds a frame to its chat and format: one moved to another topic, or
// relabelled as another version, fails to open.
const aadOf = (topic: string): Uint8Array =>
  encoder.encode(`sidechat/v${VERSION}|${topic}`)

/** Seals one message; null when it is too long to fit a frame. */
export function seal(keys: ChatKeys, payload: Payload): string | null {
  const body = encoder.encode(JSON.stringify(payload))
  const blocks = Math.ceil((body.length + 1 + HEAD_BYTES + TAG_BYTES) / BLOCK_BYTES)
  if (blocks > MAX_BLOCKS) return null
  const padded = new Uint8Array(blocks * BLOCK_BYTES - HEAD_BYTES - TAG_BYTES)
  padded.set(body)
  padded[body.length] = PAD_MARK
  // A fresh random nonce for every frame, a resend included.
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const sealed = xchacha20poly1305(fromBase64(keys.key), nonce, aadOf(keys.topic)).encrypt(padded)
  const frame = new Uint8Array(HEAD_BYTES + sealed.length)
  frame[0] = VERSION
  frame.set(nonce, 1)
  frame.set(sealed, HEAD_BYTES)

  return toBase64(frame)
}

/**
 * Opens a frame, or answers null for anything that is not a frame of this
 * chat: other text on the topic, a forgery, a frame that was changed. There
 * is no fallback to reading a body as plain text.
 */
export function open(keys: ChatKeys, frame: string): Opened | null {
  try {
    const bytes = fromBase64(frame)

    if (
      bytes.length < BLOCK_BYTES ||
      bytes.length % BLOCK_BYTES !== 0 ||
      bytes[0] !== VERSION
    ) {
      return null
    }

    const nonce = bytes.slice(1, HEAD_BYTES)
    const padded = xchacha20poly1305(fromBase64(keys.key), nonce, aadOf(keys.topic)).decrypt(
      bytes.slice(HEAD_BYTES),
    )
    let end = padded.length - 1
    while (end >= 0 && padded[end] === 0) end -= 1
    if (end < 0 || padded[end] !== PAD_MARK) return null
    const parsed: unknown = JSON.parse(decoder.decode(padded.subarray(0, end)))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { from, cid, ts, text } = parsed as Record<string, unknown>

    if (
      typeof from !== 'string' ||
      typeof cid !== 'string' ||
      typeof ts !== 'number' ||
      typeof text !== 'string'
    ) {
      return null
    }

    return { payload: { from, cid, ts, text }, nonce: toBase64(nonce) }
  } catch {
    return null
  }
}
