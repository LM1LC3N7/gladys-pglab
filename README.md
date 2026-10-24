# gladys-pglab

[Gladys Assistant](https://gladysassistant.com) external integration for
**PG LAB Electronics** boards (E-Board), over an **MQTT broker of the local
network** (the user's own, or the one of Gladys) where the boards announce
themselves: relays, shutters, and the temperature and processor voltage of
the board. Relays are switches only when declared safe, read-only
otherwise (with "Turn on" / "Turn off" buttons behind an option off by
default); shutters are never switches; what a board publishes never makes
an output commandable. **Never tested with a real board.**
**Unofficial, not affiliated with PG LAB Electronics.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (PglabApp)
                                  ├─ src/mqtt.js       mqtt.js client, one session, nothing queued offline
                                  ├─ src/protocol.js   PG LAB topics, parsers, messages (pypglab)
                                  ├─ src/model.js      boards -> Gladys devices (pure)
                                  ├─ src/store.js      /data: refused credentials, accepted layouts (no secret)
                                  └─ src/publisher.js  states within 300/min
```

- **Reads**: subscribes to `pglab/discovery/+/config`, `pglab/+/relay/+/state`,
  `pglab/+/shutter/+/state` and `pglab/+/sensor/value` only, and matches each
  topic exactly. A discovery is read up to 4 KB and checked field by field
  (the id of the topic must be the id of the payload); a state up to 512
  bytes; retained states are ignored. Two boards with the same name: their
  states are ignored.
- **Devices**: `ext:<selector>:board:<id>`, `ext:<selector>:relay:<id>-<n>`,
  `ext:<selector>:shutter:<id>-<n>` (the board id of the discovery, never
  its name); features `<device>:<role>`; a created device never loses a
  feature.
- **Accepted layouts**: per board, its MAC and layout as first announced,
  kept in `/data`; a discovery that changes them is not applied without a
  Scan, and meanwhile its relays and the opening of its shutters are
  refused (stop and close are not).
- **Commands**: one MQTT message, never queued while the broker is down,
  sent within 3.5 s or refused unsent, confirmed by the state the board
  publishes back by 4.3 s, else "sent, without confirmation".
- **Failures**: credentials refused by the broker stop the client for good
  (persisted, no automatic new try); an unreachable broker is tried every
  10 s; a reconnection to Gladys keeps the client and re-sends the status,
  the Discovery and the badges. The test button uses the same single
  session.

## Credits

The PG LAB MQTT protocol is ported from
[pypglab](https://github.com/pglab-electronics/pypglab) (PG LAB Electronics,
MIT, 0.0.5), the library of Home Assistant's PG LAB integration, and the
mapping from that integration
([home-assistant/core](https://github.com/home-assistant/core/tree/dev/homeassistant/components/pglab),
Apache-2.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled
on the sibling integrations
[gladys-qbus](https://github.com/LM1LC3N7/gladys-qbus) (local MQTT, relays
declared safe) and [gladys-velbus](https://github.com/LM1LC3N7/gladys-velbus).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
node scripts/cover.mjs cover.png                # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network, except `test/connack.test.js` (a fake broker
on 127.0.0.1): the broker and the boards are a fake mqtt.js client
(`test/helpers/fakeMqtt.js`), Gladys is the SDK's fake.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from MIT and Apache-2.0
projects, credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also
shipped in the Docker image).
