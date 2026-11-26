// Hand-written types for the one export this mod uses; scrypt.js is unmodified.
export declare function scrypt(
  password: Uint8Array,
  salt: Uint8Array,
  options: { N: number; r: number; p: number; dkLen?: number; maxmem?: number },
): Uint8Array
