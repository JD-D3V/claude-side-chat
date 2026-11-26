// Hand-written types for the one export this mod uses; sha2.js is unmodified.
export type Hash = ((message: Uint8Array) => Uint8Array) & {
  outputLen: number
  blockLen: number
}
export declare const sha256: Hash
