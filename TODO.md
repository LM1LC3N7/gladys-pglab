# TODO

## Status

Milestone 1 (0.1.0, local commit, not pushed): the PG LAB Electronics
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
- **One MQTT session**: `stop()` ends the previous client before any new
  one; the test button never opens a probe client, it (re)starts the single
  session with the saved configuration (even after refused credentials:
  the user asked) and counts the boards.
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
- **A discovery never makes an output commandable** (lesson 21 of lot 14):
  the layout (shutters, extension boards) and the MAC of each board are kept
  in `/data` as first announced. A later discovery that changes them is not
  applied: the devices keep the accepted layout, the status names the
  board, and its relay commands and shutter openings are refused until a
  Scan (Discovery tab), which accepts what the boards announce at that
  moment. Stop and close stay allowed. The first discovery of an unknown
  board is accepted (the user then chooses what to create).
- **Two boards with the same name** share their topics: their states are
  ignored (`boardByName` returns nothing) and every command but STOP is
  refused (a STOP reaching both is harmless).
- **Protective commands**: STOP (and CLOSE) of a shutter never wait behind
  anything (no queue: one publish), are never refused for a changed layout
  or MAC; their exact refusal cases are listed in the docs (lesson 29).
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
  manufacturer exact, sizes bounded (discovery 4 KB, state 512 bytes), only
  own keys read. At most 64 boards per session and 64 accepted layouts.
- **Retained states ignored** (relays, shutters, sensor): a state kept by
  the broker may be old (no availability topic in pypglab). Retained
  discoveries are used (that is how a board is found after a restart), but
  never count as "the board is alive".
- **Credentials refused** (CONNACK 4, 5, 134, 135): final stop persisted in
  `/data/pglab-state.json` (`refused: true`, no user name, no password, no
  hash), kept across restarts and Gladys reconnections, no automatic new
  try (lot 13 lesson). Other credentials saved (compared in memory only) or
  the test button try again; the stop is lifted by a successful connection
  only. CONNACK 1-3 are tried again like an unreachable broker (every 10 s).
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
