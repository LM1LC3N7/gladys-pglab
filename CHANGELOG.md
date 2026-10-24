# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- PG LAB Electronics E-Boards over an MQTT broker of the local network (the
  user's own, or the one of Gladys): the boards announce themselves
  (`pglab/discovery`), each relay, each shutter and the board itself become
  devices.
- Relays: a switch only when declared safe (`board-id:number`, or a plain
  number with a single board); otherwise a read-only state with "Turn on" /
  "Turn off" buttons behind an option off by default.
- Shutters: open, close and stop, never a switch.
- Board temperature and processor voltage, throttled (60 s by default).
- The layout and MAC address of each board are kept as first announced; a
  changed one is not applied without a Scan, and meanwhile its relays and
  the opening of its shutters are refused (stop and close are not). Two
  boards with the same name: states ignored, every command but a stop
  refused.
- Credentials refused by the broker: a final stop kept in `/data` (no
  secret there), lifted by other credentials or the test button after a
  successful connection.
- One MQTT session (the test button uses it), 300 states per minute at
  most, transport badges (a board silent for 5 minutes is unreachable),
  messages in French or English.
