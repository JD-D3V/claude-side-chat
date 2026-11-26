# Vendored libraries

The `.js` files here are copied unmodified from npm, because a mod cannot
install packages. The `.d.ts` files are hand-written and cover only the
exports this mod imports.

| Folder | Package | Version | npm integrity |
| --- | --- | --- | --- |
| `noble-ciphers/` | `@noble/ciphers` | 2.4.0 | `sha512-AnjFn0Jv92laAkvMrghlFZq4qQCIN/4DxFV/eooqtC2YTjB7kBeLMS2T9KJX4Dn+ZVXLOwK0lSgqDtx9gvxtiw==` |
| `noble-hashes/` | `@noble/hashes` | 2.4.0 | `sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==` |

Both are MIT licensed (see the `LICENSE` in each folder), by Paul Miller.
To update: `npm pack` the new version and copy the same files again.
