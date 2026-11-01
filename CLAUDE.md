# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Huddle is a lightweight Discord alternative: peer-to-peer WebRTC voice + screen sharing, plus text chat (reactions, edits, pins, replies, GIFs, images, polls) in ephemeral, optionally password-protected rooms. npm workspaces monorepo: `client/` (React 19 + Vite + Tailwind v4) and `server/` (Express 5 + Socket.IO), both TypeScript ESM.

## Commands

Run from the repo root:

```sh
npm install
npm run dev                      # server (tsx watch, :3001) + client (vite, :4173) concurrently
npm run build                    # client (tsc -b && vite build) then server (tsc -> server/dist)
npm start                        # node server/dist/index.js — serves API, Socket.IO and client/dist
npm run lint                     # eslint . (config in eslint.config.mjs); hooks and jsx-a11y rules are errors
npm run test -w client           # vitest run (client tests are colocated as *.test.ts)
npx -w client vitest run <path/to/file.test.ts> -t "<test name>"   # single test
npm run test -w server           # vitest run (server/src/*.test.ts; excluded from the tsc build)
```

vitest is declared only in `client/` (hoisted to root, where the server's script finds it). **Don't add it to another workspace:** npm 11 then prunes lightningcss binaries from the lockfile and the build fails (`Cannot find module '../lightningcss.win32-x64-msvc.node'`). Fix: `git checkout package-lock.json && npm ci`. Server tests also import `socket.io-client` through the client's hoisted copy; leave it undeclared in `server/` for the same reason. `tsc -b` in the client build is the type check; the build doesn't run lint and there is no CI, so run `npm run lint` yourself.

In dev, Vite proxies `/api` and `/socket.io` (websocket) to `localhost:3001`, so open the client at `http://localhost:4173`.

## Configuration

- Server env is loaded from `server/.env` (see `server/src/loadEnv.ts`, imported first in `index.ts`): `PORT`, `NODE_ENV`, `GIPHY_API_KEY`.
- Client env is **baked in at build time** (changing server runtime env does not affect a built client):
  - `VITE_ICE_SERVERS` — JSON `RTCIceServer[]`; defaults to Google STUN only. TURN is needed for symmetric NAT/CGNAT/strict firewalls (symptom: stuck "Connecting…" / `ICE failed`).
  - `VITE_HUDDLE_DEBUG=false` — intended to silence noisy diagnostics, but **currently has no effect**: `huddleDebugEnabled()` in `lib/huddleLog.ts` is never called (CQ-17).

## Architecture

### Server (`server/src`)
- All state is **in-memory** (`roomManager.ts`): rooms, participants, last 200 chat entries. Nothing persists across restarts. Rooms are capped at `MAX_PARTICIPANTS = 6` (full-mesh P2P doesn't scale further).
- Empty rooms (including newly created, never-joined ones) are kept for `ROOM_GRACE_MS` (60s) so clients auto-reconnecting after a shared network blip can rejoin instead of getting "Room not found". Purge is lazy in `getRoom()` plus a 30s sweep in `index.ts`; every deletion goes through `deleteRoom()`, which fires `onRoomDestroyed` (used by `index.ts` to delete the room's uploaded images). Don't delete from `rooms` directly, or cleanup is skipped.
- Socket.IO handlers are split by feature, each registering its own `io.on("connection")`: `signaling.ts` (join/leave, relays `offer`/`answer`/`ice-candidate` by socket id, mute, screen-share events), `chatHandler.ts`, `pollHandler.ts`. Socket.IO is websocket-only with a 64 KB message cap.
- **Never register a client event with a bare `socket.on`:** an uncaught throw exits the process and wipes every room. Use `on`/`onRoom`/`onRelay` (`socketRoute.ts`, catches errors; `onRoom` also resolves room + participant, `onRelay` enforces same-room peer for SDP/ICE) with a parser from `validation.ts` (`unknown` → typed value or `null`; over-limit input is rejected). Input limits and `MAX_PARTICIPANTS` live once in `server/src/limits.ts`, which the client re-exports from `types/index.ts`; keep that file import-free so the client build can compile it.
- `userId` is identity (message ownership, votes, reactions) and survives reconnects; `socket.id` is only for routing. It's a one-way hash of the client's secret `clientKey` (`identity.ts`), because it gets broadcast. Never store, broadcast or log the key, or anyone could impersonate its owner. A join with the same `userId` evicts the old entry even if its socket looks live, so `clientKey.ts` claims the key over `BroadcastChannel` first: Duplicate Tab copies sessionStorage.
- Join failures emit `error` with a stable `code` from `joinErrors.ts` (import-free, shared like `limits.ts`). The client's rejoin retry matches on the code, never the text, so messages can be reworded.
- Server error logs go through `errorSummary` (`errorLog.ts`): error name + stack frames only, since messages can quote user input. Anything reaching `uncaughtException`/`unhandledRejection` is logged and the process exits (so a supervisor restarts it), so fire-and-forget promises must not reject.
- Images are uploaded over HTTP (`imageRouter.ts`, multer) to `uploads/<roomId>/` relative to the process cwd; the directory is wiped on startup. For password-protected rooms, files are AES-256-GCM encrypted at rest with a key derived from the room password + per-room salt (`imageCrypto.ts`). `rejectEarly` requires a `Content-Length` and reserves it against the per-room quota and a process-wide in-flight cap before multer buffers the body; the handler re-checks membership, since a slow upload can outlast it or the room. Remove messages only through `removeMessage()`, which clears the pin and frees their images' files and quota.
- `giphyRouter.ts` proxies Giphy so the API key stays server-side, with a 5s upstream timeout and a bounded in-memory cache (`ttlCache.ts`) to protect the rate-limited key. Upstream URLs contain the key, so never log them.
- In production the server also serves `client/dist` with an SPA fallback route.

### Client (`client/src`)
- Two routes (`App.tsx`): `LandingPage` (create/join) and `RoomPage` (the whole call UI, which wires the hooks together).
- `hooks/useSocket.ts` owns the Socket.IO connection, room join, and **automatic rejoin after transport reconnect**, retrying a rejoin (never the first join) only while the room isn't found.
- `hooks/useWebRTC.ts` is the core and most delicate file: one `RTCPeerConnection` per remote peer (mesh), using the **perfect negotiation** pattern (polite/impolite roles, `makingOffer`, rollback on offer collision), ICE restart recovery, screen-share tracks, and the directional audio watchdog. Many comments document specific race conditions that were fixed — read them before changing negotiation logic.
- Audio pipeline (`lib/audioEngine.ts`): the outbound track is the **native `getUserMedia` track** sent directly to WebRTC (so browser AEC/NS/AGC keep working when the tab is backgrounded). Web Audio is used only for the local analyser (speaking indicator / voice gate) and remote playback (`RemoteAudioManager`). Don't route outbound audio through a Web Audio destination node — that caused robotic/muting regressions.
- Background-tab resilience: periodic real-time checks use `lib/workerTimer.ts` (Web Worker intervals aren't throttled to 1s like `setInterval`). `useTransmissionGate` (voice-activated transmission with adaptive noise floor, `lib/audioLevels.ts`) relies on this. Gate logic lives only in `stepGate`; the Settings meter reads the real gate, so don't recompute it there.
- `lib/audioWatchdog.ts` tracks inbound and outbound RTP independently per peer to detect one-directional audio stalls.
- Modal overlays use `components/Dialog.tsx` (focus trap, Escape, focus restore), with the safest action first because it gets initial focus. Lint can't see icon-only buttons, so give them an `aria-label` by hand.
- Shared client types live in `types/index.ts`; server types are defined in `roomManager.ts` — keep socket payload shapes in sync manually.

### Diagnostics
`lib/huddleLog.ts` emits always-on structured logs prefixed `[huddle:<scope>]` (`socket`, `peer`, `negotiate`, `connection`, `audio`, `watchdog`, `capture`) in dev and prod. They must never contain SDP, media, IPs, or credentials — keep it that way when adding logs. Log caught errors through `errorName`, since browser error messages can quote SDP lines. For watchdog logs, `dir: "in"` = not receiving the remote's audio, `dir: "out"` = our audio isn't reaching them.
