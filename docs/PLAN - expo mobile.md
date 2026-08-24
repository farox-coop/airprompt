# PLAN — Expo Mobile App for AirPrompt

## Context

AirPrompt currently has a single web frontend (`public/index.html` + `public/client.js`)
served by Express at port 3210. Users open `http://<LAN-IP>:3210` on their phone browser
to see session list, terminal output, and use voice dictation.

Proven pattern from reference project (see [[expo-reference-project]] memory):
monorepo with `apps/webapp/` (Next.js) + `apps/mobileapp/` (Expo). Both share packages
via `pnpm` workspace. Root `Makefile` has `make expo-clean` target that starts Expo Go
with QR code scan — user's phone instantly loads the app.

This plan applies that same pattern to AirPrompt: move current `public/` into `webapp/`,
create new `mobileapp/` Expo app that replicates every feature of the web terminal.

---

## Goal

```
airprompt/
├── server.js           ← shared backend, UNCHANGED
├── package.json        ← root: server deps + scripts
├── Makefile            ← root: targets for both apps
├── webapp/             ← current public/ moved here
│   └── public/
│       ├── index.html
│       └── client.js
└── mobileapp/          ← NEW: Expo (React Native) app
    ├── app.config.js
    ├── app.config.ts
    ├── package.json
    ├── tsconfig.json
    ├── app/
    │   ├── _layout.tsx      ← expo-router root layout
    │   └── (tabs)/
    │       ├── _layout.tsx  ← tab bar: Terminal | Sessions
    │       ├── terminal.tsx ← main terminal screen
    │       └── sessions.tsx ← session list screen
    └── src/
        ├── hooks/
        │   ├── useWebSocket.ts    ← WebSocket connection + message routing
        │   └── useVoiceDictation.ts ← voice recognition
        ├── components/
        │   ├── TerminalView.tsx   ← ANSI-colored terminal renderer
        │   ├── SessionBar.tsx     ← top bar: current session + switch
        │   ├── SessionModal.tsx   ← session picker modal
        │   ├── MicButton.tsx      ← push-to-talk dictation
        │   └── TextInputRow.tsx   ← text input + send button
        └── lib/
            └── ansi.ts           ← ANSI escape code parser (minimal)
```

Same WebSocket protocol. Same session switching. Same voice dictation. Now native app
via Expo Go — scan QR code, app loads instantly, no browser needed.

---

## Reference Project Pattern (What We Copy)

From the proven Expo monorepo pattern (see [[expo-reference-project]] for details):

| Element          | Reference Project                     | AirPrompt (our version)       |
| ---------------- | ------------------------------------- | ----------------------------- |
| Monorepo tool    | `pnpm` workspace                      | `pnpm` workspace (simple)     |
| App structure    | `apps/webapp/` + `apps/mobileapp/`    | `webapp/` + `mobileapp/`      |
| Mobile framework | Expo SDK 54 + expo-router             | Expo SDK 54 + expo-router     |
| Config           | `app.config.js`                       | `app.config.js`               |
| Navigation       | expo-router file-based, Stack + Tabs  | expo-router file-based, Tabs  |
| TypeScript       | Yes (`tsconfig.json` extends root)    | Yes                           |
| Root Makefile    | `make expo` / `make expo-clean`       | Same                          |
| Dev workflow     | `make expo-clean` → QR code → Expo Go | Same                          |
| ESLint/Prettier  | Per-app config                        | Start minimal (no config yet) |

What we do NOT copy from reference project (overkill for airprompt):

- Firebase / notifications / EAS builds — not needed yet
- Shared packages (`@<project>/api`, `@<project>/hooks`, etc.) — airprompt is simpler, no shared package layer needed
- Complex auth / onboarding flows
- Tailwind CSS / custom fonts / theming system
- `react-native-gesture-handler`, `bottom-sheet`, etc. — keep deps minimal

---

## Mobile App Feature Map (What `client.js` Does → Expo Equivalent)

| Web (`client.js`)                     | Mobile (Expo)                                            | Notes                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `new Terminal()` from xterm.js        | `<TerminalView>` component                               | Custom component: parses ANSI escape codes, renders colored `<Text>` lines in `<ScrollView>`. No native xterm.js for RN exists. |
| `term.onData()` → sends keystrokes    | Direct `ws.send()` on keyboard input                     | No PTY mode — mobile sends typed text + `\r` same as web text input                                                             |
| `term.write(msg.data)` on `output`    | Update React state, append to output buffer              | Accumulate raw ANSI string, parse, render                                                                                       |
| `new WebSocket(...)`                  | Same `new WebSocket(...)`                                | React Native has built-in WebSocket API                                                                                         |
| `session_list` message → `updateUI()` | Same → React state updates SessionBar + SessionModal     |                                                                                                                                 |
| `switch_session` message              | Same → `send({ type: 'switch_session', sessionId })`     |                                                                                                                                 |
| Modal with session items              | `<SessionModal>` as `<Modal>` or bottom sheet            |                                                                                                                                 |
| Microphone: `SpeechRecognition` API   | `expo-speech-recognition` or `@react-native-voice/voice` | Push-to-talk: hold button = record, release = send transcript + `\r`                                                            |
| Text input row                        | `<TextInput>` + `<Pressable>` send button                |                                                                                                                                 |
| Pull-to-refresh                       | `<RefreshControl>` on `<ScrollView>`                     | Reloads session list                                                                                                            |

---

## `mobileapp/` File Details

### `package.json`

```json
{
  "name": "@airprompt/mobileapp",
  "version": "0.1.0",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start",
    "android": "expo run:android",
    "ios": "expo run:ios",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "expo": "~54.0.0",
    "expo-router": "~6.0.0",
    "expo-status-bar": "~55.0.0",
    "expo-constants": "~18.0.0",
    "react": "^19.1.0",
    "react-native": "^0.81.0",
    "react-native-safe-area-context": "~5.6.0",
    "react-native-screens": "~4.16.0",
    "@react-native-voice/voice": "^3.2.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "typescript": "^5.4.0"
  }
}
```

Minimal deps. Only what's needed:

- `expo` + `expo-router` — framework + navigation
- `react-native-safe-area-context` + `react-native-screens` — required by expo-router
- `@react-native-voice/voice` — voice dictation (or `expo-speech-recognition` if available)
- `expo-status-bar` — status bar control
- `expo-constants` — read `expoConfig` for server URL (host IP, port)

### `app.config.js`

Follow the proven Expo config pattern (see [[expo-reference-project]]) exactly:

```js
module.exports = {
  expo: {
    name: 'AirPrompt',
    slug: 'airprompt',
    version: '0.1.0',
    scheme: 'airprompt',
    plugins: ['expo-router'],
    extra: {
      serverHost: process.env.AIRPROMPT_HOST || 'localhost',
      serverPort: process.env.AIRPROMPT_PORT || '3210',
    },
  },
};
```

### `tsconfig.json`

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "jsx": "react-native",
    "module": "ESNext",
    "moduleResolution": "bundler"
  },
  "include": ["app/**/*.ts", "app/**/*.tsx", "src/**/*.ts", "src/**/*.tsx"]
}
```

### `app/_layout.tsx` — Root layout

```tsx
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
```

### `app/(tabs)/_layout.tsx` — Tab bar

Two tabs:

1. **Terminal** — main screen, connects WebSocket, shows terminal output
2. **Sessions** — session list with switch capability

```tsx
import { Tabs } from 'expo-router';

export default function TabLayout() {
  return (
    <Tabs>
      <Tabs.Screen name="terminal" options={{ title: 'Terminal' }} />
      <Tabs.Screen name="sessions" options={{ title: 'Sessions' }} />
    </Tabs>
  );
}
```

### `app/(tabs)/terminal.tsx` — Main terminal screen

Replicates `index.html` terminal + controls:

- Top: `<SessionBar>` — shows current session, "Switch" button
- Middle: `<TerminalView>` — ANSI-colored terminal output in ScrollView with auto-scroll
- Bottom: `<TextInputRow>` + `<MicButton>` — text input + voice dictation

```
┌─────────────────────────────┐
│ SessionBar: ~/projects/...  │ ← tap opens SessionModal
├─────────────────────────────┤
│                             │
│ TerminalView                │
│ (ANSI output, ScrollView,   │
│  auto-scroll to bottom)     │
│                             │
├─────────────────────────────┤
│ TextInputRow: [________][>] │
│ MicButton:  🎤 Hold to Talk │
└─────────────────────────────┘
```

### `app/(tabs)/sessions.tsx` — Session list screen

Replicates the session modal from web:

- Lists all sessions from `session_list` WebSocket messages
- Shows CWD + timestamp
- Tap to switch (sends `switch_session` message)
- Active session highlighted
- Pull-to-refresh reloads session list (sends `list_sessions`)

---

## Core Components

### `<TerminalView>` — ANSI terminal renderer

Most critical component. xterm.js doesn't exist for React Native. Build minimal ANSI parser:

```tsx
// Receives raw ANSI string via WebSocket 'output' messages
// Parses ANSI escape codes (colors, cursor movements, clear screen)
// Renders lines as <Text> components with inline styles
// Auto-scrolls to bottom on new output

interface TerminalViewProps {
  outputBuffer: string; // accumulated raw ANSI output
}
```

ANSI parser handles:

- Colors: 16 standard + bright variants (same palette as web xterm.js theme)
- `\x1b[0m` — reset
- `\x1b[31m` etc. — foreground colors
- `\x1b[K` — clear line
- `\x1b[2J` — clear screen
- `\r\n` — newline
- `\r` — carriage return (overwrite current line)
- Cursor movements (basic: `\x1b[nA`, `\x1b[nB`, `\x1b[nC`, `\x1b[nD`)

Not implementing:

- Mouse events, bracketed paste, true color (256/16M), cursor positioning beyond basic movements

Implementation approach: maintain `lines: string[]` state. Each ANSI output chunk updates lines. Render as `<ScrollView>` with `<Text style={lineStyle}>` per line.

### `<SessionBar>` — Top bar

```tsx
// Shows active session CWD or "No session selected"
// "Switch" button opens SessionModal
// Uses useWebSocket context for session state
```

### `<SessionModal>` — Session picker

```tsx
// React Native <Modal>
// Lists sessions from WebSocket session_list messages
// Tap session → switch + close
// Close button
// "No active sessions" empty state
```

### `<MicButton>` — Voice dictation

```tsx
// Push-to-talk: PressIn → start listening, PressOut → stop + send
// Uses @react-native-voice/voice
// Visual feedback: red pulsing while recording
// Error state: "Mic not available"
```

### `<TextInputRow>` — Keyboard input

```tsx
// <TextInput> + "Send" <Pressable>
// Sends text + \r via WebSocket
// Also handles Enter key
```

---

## `useWebSocket` Hook

Central state management for WebSocket connection. Provides React context to all components:

```ts
interface AirPromptContext {
  // Connection
  ws: WebSocket | null;
  connected: boolean;

  // Sessions
  sessions: Session[];
  activeSessionId: string | null;

  // Terminal output (raw ANSI string, accumulated)
  outputBuffer: string;

  // Actions
  sendInput(data: string): void;
  switchSession(sessionId: string): void;
  requestSessionList(): void;
}
```

On mount:

1. Read server URL from `expo-constants` `expoConfig.extra` (AIRPROMPT_HOST + AIRPROMPT_PORT)
2. Connect WebSocket to `ws://<host>:<port>`
3. Parse incoming JSON messages: `output` → append to buffer, `session_list` → update state, `error` → show alert
4. On `session_list`: auto-select first session if none active

---

## WebSocket Protocol (Identical to Web)

Same JSON protocol as `docs/PLAN.md` section 4:

**Client → Server:**

```json
{"type": "input", "data": "ls -la\r"}
{"type": "switch_session", "sessionId": "1720000000-myproject"}
{"type": "list_sessions"}
```

**Server → Client:**

```json
{"type": "output", "data": "\x1b[32m...terminal output...\x1b[0m"}
{"type": "session_list", "sessions": [{"id": "...", "cwd": "...", "createdAt": "..."}]}
```

Server is unchanged. Zero backend modifications.

---

## Root `Makefile` Changes

Add expo targets following the reference project pattern (see [[expo-reference-project]]):

```makefile
.PHONY: expo expo-clean

expo: ## Start Expo dev server (mobileapp/)
  @cd mobileapp && npx expo start -c --go

expo-clean: clean setup expo ## Clean + setup + start Expo dev server
```

Existing targets (`start`, `stop`, `test-all`, etc.) unchanged.

---

## Root `package.json` Changes

Minimal. Keep as-is. Optionally add workspace reference:

```json
{
  "workspaces": ["webapp", "mobileapp"]
}
```

But since airprompt is simple (server at root, no shared packages), workspace may not be needed. The mobile app is self-contained — its `package.json` has all its own deps. `pnpm-workspace.yaml` only if we want `pnpm` monorepo tooling. For now: **no workspace needed**. Keep it simple.

---

## What Stays Unchanged

| File                                                                | Why                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `server.js`                                                         | WebSocket protocol + REST API unchanged. Both webapp and mobileapp use same server. |
| `webapp/public/index.html`                                          | Only moves location. Content unchanged.                                             |
| `webapp/public/client.js`                                           | Same.                                                                               |
| `bin/airprompt-register.sh`                                         | Unchanged.                                                                          |
| `bin/airprompt-unregister.sh`                                       | Unchanged.                                                                          |
| `.claude/skills/airprompt.md`                                       | Unchanged.                                                                          |
| `.claude/commands/airprompt.md`                                     | Unchanged.                                                                          |
| `package.json` (root, deps: express, ws, node-pty, qrcode-terminal) | Unchanged.                                                                          |
| `test/` suite                                                       | Unchanged.                                                                          |

---

## Implementation Steps (Ordered)

### Step 1: Move `public/` into `webapp/public/`

- Create `webapp/` directory
- Move `public/` → `webapp/public/`
- Update `server.js` static path: `app.use(express.static(path.join(__dirname, 'webapp', 'public')))`
- Verify `npm start` still serves web app at `http://localhost:3210`

### Step 2: Create `mobileapp/` Expo project

- `cd mobileapp && npx create-expo-app@latest . --template blank-typescript`
- Or manually: create `package.json`, `app.config.js`, `tsconfig.json` from plan above
- Install deps: `expo-router`, `react-native-safe-area-context`, `react-native-screens`, `@react-native-voice/voice`
- Set up `app/_layout.tsx` with expo-router Stack
- Set up `app/(tabs)/_layout.tsx` with Terminal + Sessions tabs
- Verify `npx expo start` launches Expo Go with working app shell

### Step 3: Build `useWebSocket` hook

- Create `src/hooks/useWebSocket.ts`
- WebSocket connection to server (read host/port from expo-constants extra)
- Parse JSON messages: `output`, `session_list`, `error`
- State: `sessions`, `activeSessionId`, `outputBuffer`, `connected`
- Actions: `sendInput`, `switchSession`, `requestSessionList`
- Wrap in React context so all components access same state
- Auto-select first session on connect
- Reconnect on disconnect with backoff

### Step 4: Build `<TerminalView>` component

- Create `src/lib/ansi.ts` — minimal ANSI parser
- Create `src/components/TerminalView.tsx`
- `ScrollView` with auto-scroll to bottom (`onContentSizeChange`)
- Each line rendered as `<Text>` with color styles from ANSI parser
- Dark theme matching web xterm.js colors
- Efficient: only re-render when new output arrives (use `React.memo`)

### Step 5: Build `<SessionBar>` + `<SessionModal>`

- `SessionBar.tsx`: shows active session CWD, "Switch" button
- `SessionModal.tsx`: React Native `<Modal>`, FlatList of sessions, tap to switch, close button
- Empty state: "No active sessions" message

### Step 6: Build `<TextInputRow>` + `<MicButton>`

- `TextInputRow.tsx`: `<TextInput>` + `<Pressable>` send button, Enter key support
- `MicButton.tsx`: PressIn/PressOut gesture, `@react-native-voice/voice` integration
- Recording state visual feedback (red background, pulsing)
- Error state: mic not available
- On result: send transcript + `\r` via WebSocket

### Step 7: Wire `terminal.tsx` screen

- Compose all components: SessionBar + TerminalView + TextInputRow + MicButton
- Connect to useWebSocket context
- Handle keyboard avoidance (keyboard pushes terminal up)

### Step 8: Wire `sessions.tsx` screen

- FlatList of sessions from useWebSocket context
- Active session highlighted
- Tap to switch
- Pull-to-refresh: RefreshControl calls `requestSessionList()`

### Step 9: Update root `Makefile`

- Add `expo` target: `cd mobileapp && npx expo start -c --go`
- Add `expo-clean` target: `clean setup expo`
- Update `.PHONY` line

### Step 10: Update `README.md`

- Document new directory structure
- Document `make expo-clean` for mobile dev
- Show Expo Go QR code workflow

---

## Verification (Manual QA)

1. Start server: `node server.js` → `http://localhost:3210`
2. Start mobile: `cd mobileapp && npx expo start --go`
3. Scan QR code with Expo Go on phone
4. Register session: `bash bin/airprompt-register.sh`
5. **Check**: app shows session in tab bar
6. **Check**: switch to Terminal tab → auto-selects session
7. **Check**: terminal shows shell prompt output
8. **Check**: type text + send → appears in terminal
9. **Check**: hold mic button → transcript sent to terminal
10. **Check**: switch to Sessions tab → sees session list
11. **Check**: tap different session → Terminal switches
12. **Check**: unregister → session removed from list
13. **Check**: web app (`http://localhost:3210`) still works alongside mobile app
14. **Check**: two clients (web + mobile) on same session both see output

---

## What We Explicitly Don't Do (Yet)

- **EAS Build** — Expo Go is sufficient for development. EAS for production builds later.
- **iOS/Android native builds** — `expo run:ios` / `expo run:android` only when needed.
- **Push notifications** — not in web app, not in mobile. Add later if needed.
- **QR code for server URL** — web app generates QR for LAN URL. Mobile can scan that. Or user types host IP in app settings. Start simple: hardcode `localhost` default, env var override.
- **App store publishing** — Expo Go only for now.
- **Offline mode** — needs WebSocket connection to server.
- **Terminal resize / FitAddon equivalent** — start with fixed terminal dimensions. Add resize later.
- **Complex ANSI features** — 256 color, true color, mouse events, bracketed paste. Not needed for tmux terminal mirroring.
