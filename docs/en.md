# PG LAB Electronics for Gladys

This integration reads and controls the **PG LAB Electronics E-Board** boards
through an **MQTT broker** on your local network: their relays, their
shutters, and the temperature and processor voltage of the board. Nothing
goes through the Internet.

> **Never tested with a real board.**
> This integration has never been tested with a real PG LAB board: it
> follows the MQTT protocol of pypglab, the library PG LAB Electronics wrote
> for Home Assistant. Unofficial, not affiliated with PG LAB Electronics.
> Feedback is welcome.

## What you need

1. **An MQTT broker** the boards and Gladys can both reach. Two choices:
   - **your own broker** (Mosquitto on a Raspberry Pi, a NAS…): type its IP
     address;
   - **the broker of Gladys**: in Gladys, open **Integrations → MQTT**, start
     the broker it offers and note its user and password. Then type
     `mqtt://<IP address of the Gladys machine>:1883` (the configuration
     screen shows the address it guesses). **Never `localhost`**: the
     integration runs in its own container, where `localhost` is the
     container itself. A firewall on the Gladys machine must let port 1883
     through.
2. **Each board set to that broker**: in the MQTT settings of the E-Board
   (its web page), type the same broker, user and password. The board then
   announces itself under `pglab/discovery/<id>/config` and publishes its
   states under `pglab/<name>/…`.

Anybody allowed to publish on the broker can impersonate a board: give the
broker a password, and keep it on your local network.

## Setting up

1. Install the integration, then open its **Configuration** tab.
2. Type the address of the broker, and its user and password if it asks
   for them. The password is kept by Gladys in its database, never shown
   again, sent only to your broker.
3. Click **Test the connection**: it connects (or reconnects) the single
   session of the integration and counts the boards that announced
   themselves.
4. Open the **Discovery** tab and create the devices you want.

## What you get

| Device                   | Features                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| The board                | board temperature (°C), processor voltage (V), read only                     |
| Each shutter             | open / close / stop (a shutter, never a switch)                              |
| Each relay, by default   | its state (read only), **Turn on** and **Turn off** buttons (off by default) |
| Each relay declared safe | a switch (on/off)                                                            |

A relay may feed anything: a lamp, but also a circulator, the boiler, a
heater, a freezer, a gate. A "turn everything off / on" of a voice
assistant or a scene reaches every switch. So a relay is a switch only when
**you** declare it safe:

- **Relays declared safe**: the numbers of the relays (parameter
  `PGLAB_RELAY` in the Discovery tab), for example `4, 5`. With several
  boards, write `board-id:number` (parameter `PGLAB_ID`), for example
  `DD53AC85:5`: a plain number is then applied nowhere (the status says so).
- **Allow the "Turn on" / "Turn off" buttons**: off by default. While off,
  the buttons of the relays not declared safe send nothing.

What a board announces never turns a relay into a switch, and never makes a
relay commandable: only these two settings do.

## When a board changes its configuration

The integration keeps, for each board, the configuration you accepted: its
MAC address, its number of shutters and its extension boards (in
`/data/pglab-state.json`, without any user name or password). The first
announcement of a new board is accepted as it is. If a board later
announces another configuration (other shutters, other relays) or comes
with another MAC address, it is **not applied**: the status says so, and
until you click **Scan** in the Discovery tab, its relays and the opening of
its shutters are refused. Clicking **Scan** accepts what the boards announce
at that moment.

Two boards with the same name share their topics: their states are ignored
and every command but a stop is refused until one of them is renamed (or
the old retained announcement of a board you removed is cleared from the
broker).

## When a command is refused

A **stop** of a shutter is refused only in these cases:

- the shutter is not known in this session (the board has not announced
  itself since the connection to the broker, or withdrew its announcement);
- the broker is not connected;
- the value received is not a shutter command;
- the command could not leave within 3.5 s of the click (nothing waits in
  front of a stop, so this should not happen).

A **close** is refused in the same cases, and also when two boards use the
same name. An **open** and the relay commands are refused in these cases,
and also when the configuration of the board changed or another MAC address
answers for it (until a Scan), when the relay is not declared safe (its
switch), or when the buttons are off (its buttons).

A command is sent once, never queued while the broker is down. When the
board does not publish the expected state within about 4 seconds, Gladys
says "sent, without confirmation".

## Connection problems

- **Broker unreachable**: the integration tries again every 10 seconds.
- **Credentials refused**: the integration stops for good (also after a
  restart) and tries nothing by itself. Save other credentials, or click
  **Test the connection**; the stop is lifted once a connection succeeds.
- **No board announced itself**: check the MQTT settings of the boards.
- A board that published nothing for 5 minutes is shown unreachable (the
  board sends its temperature about every minute).

## Limits

- E-Switch and E-Relay boards are recognised but offer nothing yet (pypglab
  0.0.5 gives them no output).
- The inputs of the board are not offered: pypglab has no topic for them.
- The states kept by the broker (retained) are ignored: they may be old.
  A relay shows its state at its next change.
- At most 64 boards, 64 relays and 32 shutters per board.
- The time since the last restart of the board (`rtime`) is not offered.
