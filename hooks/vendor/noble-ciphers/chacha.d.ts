// Hand-written types for the one export this mod uses; chacha.js is unmodified.
export declare const xchacha20poly1305: (
  key: Uint8Array,
  nonce: Uint8Array,
  aad?: Uint8Array,
) => {
  encrypt(plaintext: Uint8Array): Uint8Array
  decrypt(ciphertext: Uint8Array): Uint8Array
}
