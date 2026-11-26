// Hand-written types for the one export this mod uses; hkdf.js is unmodified.
import type { Hash } from './sha2.js'

export declare function hkdf(
  hash: Hash,
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: Uint8Array | undefined,
  length: number,
): Uint8Array
