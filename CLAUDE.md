# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for PG LAB Electronics boards
(E-Board): a Node.js service (Node 22+, ESM, no build step) that runs in its
own sandboxed Docker container, talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
and to an MQTT broker of the local network through `mqtt` (mqtt.js), where
the boards announce themselves and publish. Unofficial, not affiliated with
PG LAB Electronics.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run audit                             # npm audit --omit=dev
node scripts/cover.mjs cover.png          # regenerate the cover
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI runs `format:check`, `lint` and `test` on Node 22 and 24.

## Architecture

```
index.js           SDK wiring only
src/handlers.js    the SDK handlers -> PglabApp (shared with the tests)
src/app.js         the session, messages, devices, states, commands, test button
src/protocol.js    PG LAB topics, parsers, messages (ported from pypglab)
src/model.js       boards -> Gladys devices, readers and writers (pure)
src/mqtt.js        mqtt.js client options, error reasons
src/store.js       /data: refused credentials, accepted layouts (never a secret)
src/publisher.js   states within 300 per minute
src/config.js      the manifest config_schema, normalized
src/i18n.js        runtime texts, English and French
```

## Rules

- **External ids are forever**: `ext:<selector>:board:<id>`,
  `relay:<id>-<n>`, `shutter:<id>-<n>`, features `<device>:<role>`
  (src/constants.js FEATURES). Never change one.
- **A relay is a switch only when declared safe** by the user; never a
  switch for a shutter. What a board publishes never makes an output
  commandable: a changed layout or MAC needs a Scan.
- **Stop and close are never held** behind anything.
- **One MQTT session**; nothing queued while the broker is down
  (`queueQoSZero: false`).
- **Never a secret** in the logs, `/data`, a status or an error. The
  password is "kept by Gladys in its database, never shown again" (Gladys
  stores it in clear: never claim more, `test/manifest.test.js` checks it).
- **Untrusted input**: everything from the broker is bounded and
  type-checked; topics matched exactly; names checked before they go into a
  topic; only own keys.
- **Versions** belong to the Release workflow; **changelog** lines go under
  `## [Unreleased]`.
- **Texts** are bilingual (English and French), UTF-8 without BOM
  (`test/encoding.test.js`). Tests never touch the network.
