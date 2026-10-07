# krn

`krn` is a local engineering harness. This repository starts the J1 module
boundaries and CLI strangler seam described by the product blueprint.

Use Node 24.21.0, then run `pnpm install` and `npm run gate`. The `krn` bin
forwards unknown commands only when `KRN_LEGACY_BIN` is set.
