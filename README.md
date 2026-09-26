# Huddle

Huddle is a vibe coded lightweight Discord alternative for voice and text chatting with screen sharing feature.

![screenshot](https://github.com/TolgaGolet/huddle/blob/main/screenshots/Screenshot_1.png)
![screenshot](https://github.com/TolgaGolet/huddle/blob/main/screenshots/Screenshot_2.png)
![screenshot](https://github.com/TolgaGolet/huddle/blob/main/screenshots/Screenshot_3.png)

## Voice connectivity (STUN / TURN)

Huddle uses peer-to-peer WebRTC. ICE servers are configured at **client build
time** via the `VITE_ICE_SERVERS` environment variable (a JSON
`RTCIceServer[]`). If unset, the client falls back to two public Google **STUN**
servers.

- **STUN** only helps the two peers discover their public network addresses so
  they can try a _direct_ connection. It works for most home/office NATs.
- **TURN** is a relay used when a direct path cannot be established (symmetric
  NAT, carrier-grade NAT/CGNAT, strict corporate firewalls). Without TURN, some
  network pairs can exchange signaling but never pass media — this shows up as a
  long "Connecting…" state and/or `WebRTC: ICE failed` in the browser console.

To support those networks, deploy a TURN server and bake its configuration into
the client build:

```sh
VITE_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"...","credential":"..."}]' npm run build -w client
```

Changing only the server's runtime environment does **not** update an
already-built client. Keep TURN credentials out of source control; prefer
short-lived/ephemeral credentials issued by your TURN provider.

## Diagnosing one-way audio

The client emits structured, privacy-safe logs prefixed with `[huddle:<scope>]`
(`socket`, `peer`, `negotiate`, `connection`, `audio`, `watchdog`, `capture`).
They contain no SDP, media, IP addresses, or credentials. Useful scopes when
someone "can be heard but cannot hear":

- `[huddle:socket]` — `disconnect` reason and `connect-error`; a transport drop
  tears down all peers and forces a rejoin.
- `[huddle:connection]` / `[huddle:negotiate]` — ICE/connection state and
  offer/answer/rollback transitions.
- `[huddle:watchdog]` — directional audio-stall detection. Inbound and outbound
  RTP are tracked **independently**, so a stalled direction is detected even
  while the other keeps flowing. `dir: "in"` means we stopped receiving the
  remote's audio; `dir: "out"` means our audio stopped reaching them.

For deeper inspection use the browser's own tools: `chrome://webrtc-internals`
(Chromium/Brave) or `about:webrtc` (Firefox). Compare the audio `outbound-rtp`
and `inbound-rtp` packet/byte counters on **both** sides to see which direction
stopped, and check the selected ICE candidate pair (host/srflx/relay).

## Tests

```sh
npm run test -w client   # unit tests (directional audio watchdog)
```
