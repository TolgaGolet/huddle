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
- Deployed on Render: `proxyHopsFor` (`ipRateLimit.ts`) detects Render's automatic `RENDER` env var and uses a hard-coded proxy count. **On any other host behind a proxy, update it**, or every user shares the proxy's IP and one set of per-IP rate limits.
- Client env is **baked in at build time** (changing server runtime env does not affect a built client):
  - `VITE_ICE_SERVERS` — JSON `RTCIceServer[]`; defaults to Google STUN only. TURN is needed for symmetric NAT/CGNAT/strict firewalls (symptom: stuck "Connecting…" / `ICE failed`).

## Architecture

### Server (`server/src`)
- All state is **in-memory** (`roomManager.ts`): rooms, participants, last 200 chat entries. Nothing persists across restarts. Rooms are capped at `MAX_PARTICIPANTS = 6` (full-mesh P2P doesn't scale further).
- Empty rooms (including newly created, never-joined ones) are kept for `ROOM_GRACE_MS` (60s) so clients auto-reconnecting after a shared network blip can rejoin instead of getting "Room not found". Purge is lazy in `getRoom()` plus a 30s sweep in `index.ts`; every deletion goes through `deleteRoom()`, which fires `onRoomDestroyed` (used by `index.ts` to delete the room's uploaded images). Don't delete from `rooms` directly, or cleanup is skipped.
- Socket.IO handlers are split by feature, each registering its own `io.on("connection")`: `signaling.ts` (join/leave, relays `offer`/`answer`/`ice-candidate` by socket id, mute, screen-share events), `chatHandler.ts`, `pollHandler.ts`. Socket.IO is websocket-only with a 64 KB message cap.
- **Never register a client event with a bare `socket.on`:** an uncaught throw exits the process and wipes every room. Use `on`/`onRoom`/`onRelay` (`socketRoute.ts`, catches errors; `onRoom` also resolves room + participant, `onRelay` enforces same-room peer for SDP/ICE) with a parser from `validation.ts` (`unknown` → typed value or `null`; over-limit input is rejected). Input limits and `MAX_PARTICIPANTS` live once in `server/src/limits.ts`, which the client re-exports from `types/index.ts`; keep that file import-free so the client build can compile it.
- Rate limits: `register` in `socketRoute.ts` applies the per-socket buckets in `rateLimit.ts` (import-free, shared), and `tsc` requires a row in `EVENT_LIMITS` for every event in `protocol.ts`. `ipRateLimit.ts` limits connections and HTTP routes per IP, and wrong passwords per room + IP; connections use `allowRequest`, not `io.use`, because a middleware rejection stops the client reconnecting.
- `userId` is identity (message ownership, votes, reactions) and survives reconnects; `socket.id` is only for routing. It's a one-way hash of the client's secret `clientKey` (`identity.ts`), because it gets broadcast. Never store, broadcast or log the key, or anyone could impersonate its owner. A join with the same `userId` evicts the old entry even if its socket looks live, so `clientKey.ts` claims the key over `BroadcastChannel` first: Duplicate Tab copies sessionStorage.
- Join failures emit `error` with a stable `code` from `joinErrors.ts` (import-free, shared like `limits.ts`). The client's rejoin retry matches on the code, never the text, so messages can be reworded.
- Server error logs go through `errorSummary` (`errorLog.ts`): error name + stack frames only, since messages can quote user input. Anything reaching `uncaughtException`/`unhandledRejection` is logged and the process exits (so a supervisor restarts it), so fire-and-forget promises must not reject.
- Images are uploaded over HTTP (`imageRouter.ts`, multer) to `uploads/<roomId>/` relative to the process cwd; the directory is wiped on startup. For password-protected rooms, files are AES-256-GCM encrypted at rest with a key derived from the room password + per-room salt (`imageCrypto.ts`). `rejectEarly` requires a `Content-Length` and reserves it against the per-room quota and a process-wide in-flight cap (`MAX_INFLIGHT_IMAGE_BYTES`, shared with decrypting reads, which get 503 when it or their room's share is full and are cut off at `IMAGE_READ_TIMEOUT_MS`; open-room reads are streamed) before multer buffers the body; the handler re-checks membership, since a slow upload can outlast it or the room. Remove messages only through `removeMessage()`, which clears the pin and frees their images' files and quota.
- Image uploads and `image-session` authenticate with `X-Participant-Token`, a per-membership secret sent only in the owner's `room-joined`. Never use the socket id here (the room can see it), put the token on `Participant`, or log it.
- Image reads are authorized by an HttpOnly cookie from `POST /rooms/:id/image-session`, opened on every join and renewed by `keepImageSessionOpen`, never by a token in the URL, which would reach access logs. Render room images with `RoomImage`, which waits for the session and retries failed loads when it reopens. Open rooms' images are `no-cache` so leaving still ends access; password rooms stay `no-store` so decrypted files never reach the browser's disk cache.
- `giphyRouter.ts` proxies Giphy so the API key stays server-side, with a 5s upstream timeout and a bounded in-memory cache (`ttlCache.ts`) to protect the rate-limited key. Upstream URLs contain the key, so never log them.
- `httpErrors.ts` ends the Express chain: fixed reply text, logs via `errorSummary`. Never pass errors to Express's default handler, which logs the raw stack and can quote the request body.
- Clients send only `replyToId`; the server builds reply quotes from its own history (`chatHandler.ts`), so a quote can't be forged. Editing the original updates its quotes and removing it clears them, on both sides (`chatHistory.ts`).
- `join-room` carries mute state so a rejoin is right from the first event. Clients announce `isMuted || micUnavailable` (`RoomPage`), so a user with no working mic shows as muted.
- In production the server also serves `client/dist` with an SPA fallback route.

### Client (`client/src`)
- Two routes (`App.tsx`): `LandingPage` (create/join) and `RoomPage`, which redirects visitors with no name and otherwise mounts `RoomCall` (the whole call UI, which wires the hooks together). Keep side effects (socket, mic) in `RoomCall`, so a redirecting visitor gets no mic prompt.
- `hooks/useSocket.ts` owns the Socket.IO connection, room join, and **automatic rejoin after transport reconnect**, retrying a rejoin (never the first join) only while the room isn't found.
- `lib/peerSession.ts` is the core and most delicate file: one `PeerSession` per remote peer (mesh) owns its `RTCPeerConnection` and all per-peer state, using the **perfect negotiation** pattern (polite/impolite roles, `makingOffer`, rollback on offer collision), ICE restart recovery, screen-share tracks, and the directional audio watchdog. Many comments document specific race conditions that were fixed — read them before changing negotiation logic. Put new per-peer state on the session, and check `disposed` in async callbacks, so a recreated peer starts clean. `hooks/useWebRTC.ts` holds the session map, socket wiring and React state.
- Audio pipeline (`lib/audioEngine.ts`): the outbound track is the **native `getUserMedia` track** sent directly to WebRTC (so browser AEC/NS/AGC keep working when the tab is backgrounded). Web Audio is used only for the local analyser (speaking indicator / voice gate) and remote playback (`RemoteAudioManager`). Don't route outbound audio through a Web Audio destination node — that caused robotic/muting regressions. Chromium ignores `applyConstraints` for noise suppression and reuses an open capture's processing, so toggling it stops the capture and re-acquires (a brief audio gap).
- Background-tab resilience: periodic real-time checks use `lib/workerTimer.ts` (Web Worker intervals aren't throttled to 1s like `setInterval`). `useTransmissionGate` (voice-activated transmission with adaptive noise floor, `lib/audioLevels.ts`) relies on this. Gate logic lives only in `stepGate`; the Settings meter reads the real gate, so don't recompute it there.
- `lib/audioWatchdog.ts` tracks inbound and outbound RTP independently per peer to detect one-directional audio stalls.
- Secondary text uses at least `gray-400` (lower fails WCAG AA on these backgrounds), and error messages use `role="alert"`.
- Modal overlays use `components/Dialog.tsx` (focus trap, Escape, focus restore), with the safest action first because it gets initial focus. Lint can't see icon-only buttons, so give them an `aria-label` by hand.
- Chat UI: `ChatPanel` composes `MessageList` and `Composer`. `MessageItem` is memoized, so keep its props stable and per-keystroke state in `Composer`/`MessageEditor`, or typing re-renders the whole history.
- The room stacks below `md` and uses columns from `md`. Tailwind's `hover:` never fires on touch, so touch-only behaviour uses `pointer-coarse:`, and small buttons use the `touch-target` utility (`index.css`) for 40 px tap targets.
- Socket events and payload types live once in `server/src/protocol.ts` (import-free apart from other shared files, like `limits.ts`), which the client re-exports from `types/index.ts`. Add a new event there and `tsc` checks both sides; use `AppSocket`/`AppServer`, not bare `Socket`/`Server`. No `shared/` workspace: `npm start` runs plain `node` on `tsc` output, which can't load a source-only package.

### Diagnostics
`lib/huddleLog.ts` emits always-on structured logs prefixed `[huddle:<scope>]` (`socket`, `peer`, `negotiate`, `connection`, `audio`, `watchdog`, `capture`, `clipboard`) in dev and prod. They must never contain SDP, media, IPs, or credentials — keep it that way when adding logs. Log caught errors through `errorName`, since browser error messages can quote SDP lines. For watchdog logs, `dir: "in"` = not receiving the remote's audio, `dir: "out"` = our audio isn't reaching them.
