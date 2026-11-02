# Provenance of the vendored Bun debug adapter

Upstream: <https://github.com/oven-sh/bun>, commit `38afee6c84fcf48c0edb2466aa4b27d287a59c30` (tag `bun-v1.4.4`).

Copied unmodified from, with the same relative layout (the adapter imports `../../../bun-inspector-protocol/...`):

- `packages/bun-debug-adapter-protocol/` to `bun-debug-adapter-protocol/` (`index.ts`, `package.json`, `src/`)
- `packages/bun-inspector-protocol/` to `bun-inspector-protocol/` (`index.ts`, `package.json`, `src/`)

Left out: upstream tests and test fixtures (`*.test.ts`, `src/debugger/fixtures/`), `test/`, `scripts/`, READMEs and upstream lock files. Nothing was edited.

Not upstream (omp-starter's own code, MIT like the rest of this repository):

- `stdio-adapter.ts`: serves the adapter over stdio with DAP Content-Length framing. Upstream ships no transport; its only consumer is VS Code's inline adapter.
- `package.json` and `bun.lock`: pin `semver`, `source-map-js` and `ws`, the runtime dependencies named by the two upstream `package.json` files. They are installed with `bun install --frozen-lockfile --ignore-scripts`.

## Licence

At the pinned commit the repository has one licence file, `LICENSE.md` (SHA-256 `362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd`), and neither package has its own. `LICENSE.md` begins:

> Bun itself is MIT-licensed.

It goes on to list the licences of statically linked and ported third-party code, none of which concern these two packages. `packages/bun-inspector-protocol/README.md` ends with:

> ## License
>
> MIT

`packages/bun-inspector-protocol/package.json` lists a `LICENSE` file in `files` that does not exist at this commit, and `packages/bun-debug-adapter-protocol` states no licence of its own. The repository publishes no MIT permission text or copyright line at this commit, so the terms relied on are the repository-level statement above that Bun itself is MIT-licensed.

## SHA-256 of every copied file

A test (`extensions/lib/tooling/bun-dap.test.ts`) checks that this list matches the files on disk and that no unlisted file sits in the vendored directories.

| File | SHA-256 |
| --- | --- |
| `bun-debug-adapter-protocol/index.ts` | `40bb61db0b1cfa3189bce673693b2a12cb78bdef4163f975bef542454b33b5eb` |
| `bun-debug-adapter-protocol/package.json` | `5efeae7d4a14918d87b64a9fb95736c528185b5fc02ce7a0ea962c492a3b1c3e` |
| `bun-debug-adapter-protocol/src/debugger/adapter.ts` | `60fc1164c2d344e7382dcb83c13e923cb0a2ffcf8beecbe439bef97bb05e1f55` |
| `bun-debug-adapter-protocol/src/debugger/node-socket-framer.ts` | `f048afb919b28a2633923e180a1644cf34474610cbeed53b89d5bb8bbaf2ba2b` |
| `bun-debug-adapter-protocol/src/debugger/signal.ts` | `57f15061d5b5cffa3ab3234899ba1a01cf03e82f32e14256cc96eb39700a68ee` |
| `bun-debug-adapter-protocol/src/debugger/sourcemap.ts` | `c7592de1df050a177a0b9f6f424e6bedbe469315159221ac7c8ceec16bbcc802` |
| `bun-debug-adapter-protocol/src/protocol/index.d.ts` | `59d844ba6a488cc0b0d91efb4f09f411c77c6b2de6d194c41d9b112296b1c6fa` |
| `bun-debug-adapter-protocol/src/protocol/protocol.json` | `23a4b734fc0da84fdb0e1f0a503eac8dc9ec1fc137772db2d59ad5fc0386a35e` |
| `bun-debug-adapter-protocol/src/protocol/schema.d.ts` | `e52004a345b9056ea89604e5245780d8961a720785d3114c3db7d9ab06c369ec` |
| `bun-inspector-protocol/index.ts` | `67ba6175ade161f54d391c37051ebf80df560f040f7fe7c3b6c3dd0569db9bf6` |
| `bun-inspector-protocol/package.json` | `a382a2f8371a15e99b923ece463293546ceba7f0718a45269faacf8a9dad90b5` |
| `bun-inspector-protocol/src/inspector/index.d.ts` | `c0003baa140a2dc8d4497412a22ce098a7b73263b773787452ec8e5790d330d1` |
| `bun-inspector-protocol/src/inspector/node-socket.ts` | `9ff83148f7113b1d3e4f0feb10c4f88a5c009da89f6753a8f375f7bbf3ebb263` |
| `bun-inspector-protocol/src/inspector/websocket.ts` | `3ddbe79721d263d1c926d6d674ed913707a625c58911adbf105929b84004c029` |
| `bun-inspector-protocol/src/protocol/index.d.ts` | `d11ca43dd6c71e1a9196451e56e568b06a0665d9d47a4aad872688459087f2aa` |
| `bun-inspector-protocol/src/protocol/jsc/index.d.ts` | `540ff40318a225a22dac87c55a5d1c4e46e84625c4aa427003e38c5230f21710` |
| `bun-inspector-protocol/src/protocol/jsc/protocol.json` | `04dc7f57fe87d40bf2e5fe93285575364f11ebcb532162298a4980a725553d2d` |
| `bun-inspector-protocol/src/protocol/protocol.d.ts` | `30b59f1b550214ea54b1c45e69d26a1f45ec86eba154823a8a78f20a2b87cd5e` |
| `bun-inspector-protocol/src/protocol/schema.d.ts` | `579fc8cad9c6f89ed5a3cb9debda231315980110ec90a0180f3197a0e24c39c3` |
| `bun-inspector-protocol/src/protocol/v8/index.d.ts` | `56bb8a270635bca24462f1dbbe50342a66827a6c6e62d5ab35b4a44943ce2aa1` |
| `bun-inspector-protocol/src/protocol/v8/protocol.json` | `bb97d7bf21a3dc648c65c2ea11ed652bd5e97f23de42c06d10c4b2abde0c0ebf` |
| `bun-inspector-protocol/src/util/preview.ts` | `bd8c1682f02b1c382a810cd0b34546b7049f91f7e03dece34d9b3c1500cc89d4` |
