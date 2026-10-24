# TODO

## Status

Milestone 1 (0.1.0, local commits, not pushed; review r1 fixed): the PG LAB Electronics
E-Boards read and controlled through an MQTT broker of the local network
(the user's own, or the one of Gladys): relays (switches only when declared
safe), shutters, board temperature and voltage. Never tested with a real
board nor a real broker: the tests run against a fake mqtt.js client, and
`test/connack.test.js` against a fake broker on 127.0.0.1.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-pglab:0.1.0`):
  the first patch release gives 0.1.1.
- **Reference**: pypglab 0.0.5 (MIT, PG LAB Electronics, the manufacturer),
  read at commit 2454c27, license checked in its `LICENSE` (MIT,
  "Copyright (c) 2024 pglab-electronics"); the discovery and the mapping of
  Home Assistant's PG LAB integration (Apache-2.0,
  `homeassistant/components/pglab`, `dev` branch read on 2026-10-24). Ported,
  not copied; credited in `THIRD_PARTY_NOTICES.md`, shipped in the image.
- **mqtt.js** (`mqtt` 5.16.1, MIT) for the MQTT client: the SDK has none
  (only a broker as a sub-container), and the protocol (MQTT 5 properties,
  keepalive, reconnection, CONNACK reason codes) is not worth rewriting.
  45 runtime packages: MIT or ISC, plus ieee754 (BSD-3-Clause), tslib
  (0BSD) and the SDK (Apache-2.0); `npm audit --omit=dev` clean; image
  184 MB, 12 MB more than node:24-alpine. Same choice as gladys-qbus.
- **Neighbours**: gladys-qbus (local MQTT, relays declared safe, the fake
  broker, the publisher) and gladys-velbus (read only, nothing changed).
- **The broker**: the integration needs an MQTT broker both the boards and
  Gladys reach. The user's own (Mosquitto…), or the one of Gladys (MQTT
  integration of Gladys, `eclipse-mosquitto` on the host network, port 1883,
  with its user and password): reached at `mqtt://<IP of the Gladys
machine>:1883`, never `localhost` (the integration runs in a bridge
  container). The intro section shows `mqtt://{{gladys_host}}:1883`. No
  sub-container broker of our own: the boards would need its host port,
  which only exists once started, and a second broker next to the one of
  Gladys would confuse more than it helps.
- **Message size (review r1, B1)**: MQTT 5 with `maximumPacketSize: 8192`
  (Mosquitto 2.0.20 drops a larger message instead of sending it, checked
  by the reviewer), and a guard on the raw socket (`src/mqtt.js`
  `PacketGuard`): a packet header announcing more than 8 KB cuts the
  connection before the body is buffered (tested with a fake broker
  pushing a 200 MB PUBLISH). Hence TCP and TLS only, no WebSocket (the
  guard reads the raw MQTT stream). A broker answering CONNACK 1 or 132
  (no MQTT 5) is used in 3.1.1, said in the status: the guard still
  applies, but a huge retained message then cuts every connection.
- **One MQTT session**: `stop()` ends the previous client before any new
  one; the test button never opens a probe client, it (re)starts the single
  session with the saved configuration (even after refused credentials:
  the user asked) and counts the boards.
- **The broker URL**: scheme, host and port only (no path, query or
  credentials), so it can be logged.
- **External ids**: `ext:<selector>:board:<id>`, `relay:<id>-<n>`,
  `shutter:<id>-<n>`, the `id` of the discovery (as Home Assistant keys its
  entities), never the name (the user may rename a board; the name only
  routes the topics). One Gladys device per relay and per shutter (rooms,
  names, voice assistants), one for the board (temperature, voltage).
- **Relays: switches only when declared safe** (Louis's rule, as Qbus):
  "Relays declared safe" (`safe_outputs`: `<n>` or `<id>:<n>`, 500 entries
  at most, the invalid ones only counted in the status, never shown back).
  A plain `<n>` counts only when a single board was ever accepted (count of
  the layouts in `/data`, which only grows by itself): a new board, or a
  board that withdraws its discovery, can only demote a switch, never
  promote one. The others are `unknown/binary` read only (role `state`) and
  `button/push` "Turn on" / "Turn off" (roles `turn-on`, `turn-off`),
  refused unless `allow_output_buttons` (off by default). Both sets are
  built, the other hidden: a switch created before the list changed is
  kept in the Discovery list and refused ("not declared safe").
- **A discovery never makes an output commandable** (lesson 21 of lot 14,
  review r1 points 2, 4, 5): the name, type, MAC and layout (shutters,
  extension boards) of each board are kept in `/data` as first announced.
  The routing tables come from these accepted configurations from the
  start (the Discovery tab lists the boards announced in this session).
  A later discovery that changes any of them is not applied: the status
  names the board ("old → new" for a name), its relay commands and
  shutter openings are refused until a Scan. The first discovery of an
  unknown board is accepted (the user then chooses what to create).
- **Stop and close** of a shutter of an accepted configuration go from the
  first connection, without waiting for an announcement (lesson 11), under
  the accepted name and the announced one when it differs; refused only
  when the broker is not connected, the shutter left the accepted
  configuration, the value is not a command, or 3.5 s passed (never in
  practice). Also with two boards of the same name (closing is the
  protective way, review r1 point 3).
- **Relay commands and openings** also need the board announced in this
  session with the accepted name, type, MAC and layout, and a name used by
  one board only (lesson 9).
- **Scan (review r1 point 8)**: the accepted set becomes the boards
  announced at that moment plus the accepted boards with a device in
  Gladys (their stop keeps its route), 64 at most; boards seen in passing
  are forgotten (and `single` may come back). A new id over 64 is ignored
  and counted in the status with the advice to Scan.
- **Discoveries**: an identical one (same raw payload) changes nothing; the
  devices are rebuilt at most 1.5 s after the first one of a burst, never
  pushed back (review r1 point 7).
- **Status** (review r1 point 6): a change of state (waiting, connected,
  lost, refused) is posted at once; a change of the counters only (invalid
  discoveries...) at most every 10 s.
- **Two boards with the same name** share their topics: their states are
  ignored (`boardByName` returns nothing), relays and openings refused,
  stop and close sent (they reach both).
- **Confirmation**: a command waits for the state the board publishes back
  (relay `ON`/`OFF`; shutter `OPENING`/`OPEN` for open, `CLOSING`/`CLOSED`
  for close, `OPEN`/`CLOSED` for stop) until 4.3 s after the click, else
  "sent, without confirmation". A state serves one command only (the
  oldest waiting). There is no request id in this protocol: a state
  published after the message is the best proof available.
- **Untrusted broker**: anybody allowed to publish may impersonate a board
  (documented: protect the broker). Topics matched exactly (4 or 5 levels,
  index without leading zero, below 64 or 32), the id of a discovery topic
  equal to the id of its payload, the name checked before it goes into a
  topic (`[A-Za-z0-9 _.-]`, no edge space, not "discovery"), the
  manufacturer exact, every packet bounded to 8 KB before it is read
  (above), then the payloads to 4 KB (discovery) and 512 bytes (state), only
  own keys read. At most 64 accepted boards.
- **Retained states ignored** (relays, shutters, sensor): a state kept by
  the broker may be old (no availability topic in pypglab). Retained
  discoveries are used (that is how a board is found after a restart), but
  never count as "the board is alive".
- **Credentials refused** (CONNACK 4, 5, 134, 135): final stop persisted in
  `/data/pglab-state.json` (`refused: true`, no user name, no password, no
  hash), kept across restarts and Gladys reconnections, no automatic new
  try (lot 13 lesson). MQTT 5 refusals 134, 135, 138 too. A CONNECT
  carrying credentials closed or left without CONNACK twice in a row (also
  CONNACK 2 / 133, identifier rejected) is the same final stop (lesson 13
  of lot 14, review r1 point 9). Counted only once the transport opened
  (TCP connected, TLS connected and verified: `guardedStream` says so):
  a refused certificate or a connection never opened is "unreachable" and
  tried again (review r2 N1); the status gives the reason at each
  failure; without credentials the integration keeps trying. Other
  credentials saved (compared in memory only) or the test button try
  again; the stop is lifted by a successful connection only. Other CONNACK
  refusals are tried again like an unreachable broker (every 10 s). A
  password without a user name is a configuration problem (MQTT cannot
  send it).
- **Lifting the stop by saving**: the broker, the credentials or the TLS
  check changed (`credentialsKey`).
- **Tests and clocks**: the app tests use a clock that moves on every read;
  `test/connack.test.js` runs on the real clock against local fake brokers
  (a stop sent and confirmed, a TLS server with a self-signed test
  certificate in `test/fixtures/`, a port dropping the connections).
- **`verify_certificate` off**: documented exactly (the credentials go to
  whoever answers); no certificate pinning in v1 (as gladys-qbus).
- **Session state** (boards, last seen, rejected count) is emptied on every
  connection and disconnection of the broker (lesson 9); commands before
  the boards announce themselves again are refused ("not announced").
- **Transport badge**: local when the broker is connected and the board
  published a non-retained message (state, sensor, discovery) in the last
  5 minutes (the sensor comes about every minute); checked every minute.
- **Clocks**: waits and silences use `performance.now()` (monotonic); no
  wall-clock time is kept in `/data`.
- **Measurements** (board temperature, processor voltage) throttled by
  `sensor_interval` (60 s by default); relays and shutters never, all
  within 250 states per minute for the whole integration.
- **Categories**: board temperature `device-temperature-sensor` (°C, −40 to
  125), processor voltage `energy-sensor/voltage` (V, 0 to 60: values out
  of range dropped, the scale of `volt` was never seen on a real board).
- **Not offered in v1**: E-Switch and E-Relay boards (pypglab 0.0.5 gives
  them no entity: recognised and counted in the status only); the inputs of
  the board (no topic in pypglab: nothing invented); `rtime` (seconds since
  the last restart).

## Next

- Test with a real E-Board (topics, retained or not, echo of the states,
  scale of `volt`).
- E-Switch once pypglab supports it; inputs if PG LAB documents a topic.
- An uptime or "last restart" feature from `rtime`.
