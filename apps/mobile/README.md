# Cadence for phones

An Expo app that pairs with Cadence on your computer over Wi-Fi. It shows
what the computer is playing, controls it, and can move playback to the
phone:

- **Local files** stream from the computer to the phone and keep going
  through the queue there.
- **Spotify, Apple Music and YouTube Music** songs open in that service's
  own app. The phone can't play them inside Cadence.

Only one device plays at a time. Taking over pauses the computer. Pressing
play on the computer stops the phone.

## Try it

1. On the computer: `pnpm dev`, then Settings › Phone › turn on **Phone
   sync** › **Pair a phone**. On Windows, allow Cadence through the firewall
   on private networks when asked.
2. Here: `npm install`, then `npx expo start`, and open the project in
   **Expo Go** on a phone on the same Wi-Fi.
3. In the app, **Scan the code** (or type the address and six-digit code
   shown on the computer).

Expo Go is enough for pairing, remote control and streaming. For
lock-screen controls and reliable background playback, make a development
build (`npx expo run:android` or `npx expo run:ios`).

## Layout

- `src/desktopApi.ts` HTTP calls: host info and pairing.
- `src/desktopLink.ts` the live WebSocket link and reconnect loop.
- `src/phoneSession.ts` playback on the phone (expo-audio).
- `src/tracks.ts` queue order, stream and artwork URLs, service links.
- `src/PairScreen.tsx`, `src/PlayerScreen.tsx` the two screens.

The wire protocol lives in `packages/protocol/src/remote.ts`. This app
imports its types only, so Metro never bundles code from outside this
folder.

This folder isn't part of the pnpm workspace. It installs with npm because
React Native and Electron don't share an install layout well.

```bash
npm run typecheck
npm test
```
