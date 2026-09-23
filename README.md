# Videolivecam

A desktop app (Electron + Next.js) that turns your webcam into a live AI video feed using [Xmax AI](https://platform.xmax.ai) realtime video generation. Upload a reference face image and the app transforms your camera in real time, with microphone audio sent along for lipsync.

## Requirements

- **Windows** (the `npm run electron` script and `start.bat` are Windows-specific)
- **Node.js 18 or newer** — download from [nodejs.org](https://nodejs.org)
- A **webcam** (and optionally a microphone)
- An **Xmax AI account** with an API key and credits — sign up at [platform.xmax.ai](https://platform.xmax.ai)

## Setup

1. **Clone the repo**

   ```bash
   git clone https://github.com/mrpbboss/Videolivecam.git
   cd Videolivecam
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Get an Xmax API key**

   Log in to [platform.xmax.ai](https://platform.xmax.ai), create an API key, and make sure your account has credits.

## Running the app

Double-click **`start.bat`**, or run:

```bash
npm run electron
```

This starts the Next.js server on `http://localhost:3000` and opens the app window. The first launch takes a little while as the page compiles.

To run it in a normal browser instead of the desktop window:

```bash
npm run dev
```

Then open http://localhost:3000.

## Using the app

1. Paste your **Xmax API key** into the key box.
2. Pick your **camera** (and microphone, if you want lipsync).
3. Optionally upload a **reference face image**. It is uploaded to Xmax and used as the identity for the generated video.
4. Click **Start**. The generated video appears in the output panel after a few seconds.

Errors from Xmax (for example an invalid key or no credits) are shown in the app.

## Tips

- **Performance:** the app defaults to high resolution and frame rate. If the output lags, lower the resolution / FPS. Xmax's own examples use 1472×832 at 24 fps.
- **API key security:** the key you paste is used directly in the app. Don't share builds or screenshots that expose it. For a public deployment, Xmax recommends issuing temporary keys from a backend — see the [API Key docs](https://platform.xmax.ai/docs/authentication).

## Building an installer

```bash
npm run dist
```

This builds the app and packages it with `electron-builder`. Output goes to `dist/` (not committed to the repo).

## Project structure

| Path | What it is |
| --- | --- |
| `app/page.tsx` | Main app UI and the Xmax realtime connection |
| `app/key/` | API key entry page |
| `electron.js` | Electron entry point — starts Next.js and opens the window |
| `start.bat` | One-click launcher for Windows |

## Links

- [Xmax AI docs — Quickstart](https://platform.xmax.ai/docs/quick-start)
- [Xmax realtime SDK reference](https://platform.xmax.ai/docs/capabilities/realtime-video/sdk-reference)
