# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the projects below. The ported parts
were rewritten, not copied; the changes are described below.

## pypglab

<https://github.com/pglab-electronics/pypglab> (package `pypglab`, by PG LAB
Electronics, the manufacturer, the library of Home Assistant's PG LAB
integration), version 0.0.5 of 2025-03-27, read at commit 2454c27. MIT
License (`LICENSE` of the repository). Ported: the MQTT topics of the boards
(discovery, relays, shutters, status sensor), the checks of the discovery
message (`validation.py`, `device.py`), the layout of the relays and
shutters of an E-Board from its number of shutters and its extension boards,
the relay and shutter payloads. Changed: every value received is
type-checked and bounded, the topics are matched exactly, the id of the
discovery topic must be the id of its payload, the name of a board is
checked before it goes into a topic; a changed layout or MAC address is not
applied without a Scan; relays are switches only when declared safe.

```
MIT License

Copyright (c) 2024 pglab-electronics

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Home Assistant, PG LAB integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/pglab>
(Home Assistant core, `homeassistant/components/pglab`, by PG LAB
Electronics), read on the `dev` branch on 2026-10-24. Apache License 2.0
(`LICENSE.md` of the repository), the same text as the `LICENSE` file of this
integration. Ported: the discovery topic format `pglab/discovery/<id>/config`
and the check of the id against it, what becomes a switch, a cover and a
sensor, the units of the board temperature and voltage. Changed: Gladys
devices instead of Home Assistant entities; one device per relay and per
shutter; relays read only unless declared safe. Home Assistant core has no
`NOTICE` file.

```
Copyright Home Assistant contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## mqtt.js

The runtime dependency `mqtt` (<https://github.com/mqttjs/MQTT.js>, MIT
License) is installed from npm in the image with its own license file.
