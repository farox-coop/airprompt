# PoC AirPrompt: Claude Remote Control with Voice Dictation

> **Historical document — superseded by [PLAN.md](PLAN.md).** This describes the original single-session PoC. The implementation evolved to a multi-session architecture with session registry, tmux multiplexing, and statusline integration. Refer to PLAN.md for current design.

## Overview
This document summarizes the architecture and implementation steps for an MVP (Minimum Viable Product) that bridges the gap between the user and a local Claude CLI agent. 
The goal is to allow the user to view the remote Claude session (running on a home LAN laptop with Ubuntu 24.04.4 LTS) from their mobile phone, and interact by sending prompts via voice dictation instantly.

## Evaluated Options

1. **Claude Code Remote Control (Native):** Using `claude --remote` or `/rc` to establish a local tunnel and scan the QR code from the phone. Uses native mobile keyboard dictation.
2. **Agent CLI (Open Source):** Alternative based on local keyboard shortcuts to inject Whisper transcriptions directly, though less focused on "remote" control from the mobile phone.
3. **Custom MVP Development ("Full-Custom" Architecture):** Custom solution with full control over the UX.

---

## Custom MVP Architecture

### Tech Stack
* **Backend (Node.js on Ubuntu LAN):**
  * `node-pty`: To create a pseudoterminal and link input/output streams (stdin/stdout) of the underlying CLI process.
  * `ws` / `socket.io`: WebSocket server for bidirectional communication.
  * `express`: Basic HTTP server to serve the frontend.
* **Frontend (Mobile Web/PWA):**
  * `xterm.js`: To render the terminal in the mobile web browser, interpreting console colors and formats.
  * **Web Speech API:** Native browser interface for instant voice recognition (dictation) and push-to-talk.

### Reference Code

#### 1. Backend (`server.js`)
```javascript
const express = require('express');
const { WebSocketServer } = require('ws');
const os = require('os');
const pty = require('node-pty');
const http = require('http');

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash'; // Can be changed to 'claude'

wss.on('connection', (ws) => {
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: process.env.HOME,
        env: process.env // Inherits Ubuntu environment
    });

    ptyProcess.onData((data) => ws.send(data));
    ws.on('message', (message) => ptyProcess.write(message.toString()));
    ws.on('close', () => ptyProcess.kill());
});

server.listen(3000, '0.0.0.0', () => {
    console.log('🚀 Server running on http://0.0.0.0:3000');
});
```

#### 2. Frontend (`public/index.html`)
```html
<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm/css/xterm.css" />
    <script src="https://cdn.jsdelivr.net/npm/xterm/lib/xterm.js"></script>
    <style>
        body { background: #000; margin: 0; display: flex; flex-direction: column; height: 100vh; }
        #terminal-container { flex-grow: 1; overflow: hidden; }
        #mic-btn { padding: 20px; font-size: 24px; background: #333; color: white; border: none; }
        #mic-btn.recording { background: #d32f2f; }
    </style>
</head>
<body>
    <div id="terminal-container"></div>
    <button id="mic-btn" onpointerdown="startDictation()" onpointerup="stopDictation()">
        🎤 Hold to Dictate
    </button>

    <script>
        const term = new window.Terminal({ cursorBlink: true, fontSize: 14 });
        term.open(document.getElementById('terminal-container'));

        const ws = new WebSocket(`ws://${window.location.host}`);
        ws.onmessage = (event) => term.write(event.data);
        term.onData((data) => ws.send(data));

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        let recognition = null;
        const micBtn = document.getElementById('mic-btn');

        if (SpeechRecognition) {
            recognition = new SpeechRecognition();
            recognition.lang = 'en-US';
            recognition.interimResults = false;
            recognition.continuous = true;

            recognition.onresult = (event) => {
                const transcript = event.results[event.results.length - 1][0].transcript;
                ws.send(transcript + '\r');
            };
        } else {
            micBtn.innerText = "Dictation not supported";
        }
        
        function startDictation() {
            if (recognition) {
                recognition.start();
                micBtn.classList.add('recording');
                micBtn.innerText = "🛑 Listening...";
            }
        }

        function stopDictation() {
            if (recognition) {
                recognition.stop();
                micBtn.classList.remove('recording');
                micBtn.innerText = "🎤 Hold to Dictate";
            }
        }
    </script>
</body>
</html>
```
