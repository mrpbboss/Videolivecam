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

Double-click **`start.bat`**. It checks that Node.js is installed, installs the packages automatically on first run (so step 2 is optional), warns if port 3000 is busy, and then opens the app. Keep its window open while you use the app.

Or run it manually:

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

Errors from Xmax (for example an invalid key or no credits) are shown in the app, under the **Start** button.

## Troubleshooting

### The app doesn't open / `start.bat` closes straight away
- Run `start.bat` again and read its window: it checks Node.js, installs packages and explains what failed.
- **"Node.js was not found"** — install Node (the `node-v24.13.0-x64.msi` in this folder, or [nodejs.org](https://nodejs.org)), then **restart the computer**. Check with `node -v`.
- **Package install failed** — check the internet connection, delete the `node_modules` folder and run `start.bat` again. You can also run `npm install` manually in the project folder.
- **"Port 3000 is already in use"** — the app (or another dev server) is already running. Close it, or restart the computer.
- Extract the project to a short path such as `C:\Videolivecam` — not inside OneDrive.

### Start shows a network error
For example: `There seems to be a network issue... (NETWORK_ERROR, stage: session_api, ...)`

1. **Find the exact cause:** in the app press **Ctrl + Shift + I** (or **View → Toggle Developer Tools**), open the **Console** tab, click **Start** again and look for a red line ending in `net::ERR_...`.
2. **Match the code:**

| Error code | Cause | Fix |
| --- | --- | --- |
| `ERR_PROXY_CONNECTION_FAILED` | Windows is set to use a proxy that isn't running — often left behind by a VPN or proxy app | **Settings → Network & Internet → Proxy**: turn off **Use a proxy server** and **Use setup script**, then restart the app |
| `ERR_CERT_...` | The certificate isn't trusted — usually antivirus HTTPS scanning or a wrong clock | Turn off the antivirus web shield / HTTPS scanning; turn on **Set time automatically** |
| `ERR_CONNECTION_RESET` / `ERR_CONNECTION_CLOSED` / `ERR_BLOCKED_BY_...` | Antivirus, firewall or the network is blocking the app | Allow **Electron** and **Node.js** in the firewall/antivirus, or test on a phone hotspot |
| `ERR_NAME_NOT_RESOLVED` | DNS can't find Xmax's server | Set DNS to `8.8.8.8` / `1.1.1.1` and run `ipconfig /flushdns` |

3. **Check Xmax is reachable** from Command Prompt:

   ```bash
   curl -I --ssl-no-revoke https://api.xmax.ai
   ```

   A reply starting `HTTP/1.1 404` means the server is reachable (the 404 is expected). If Command Prompt works but the app doesn't, the cause is almost always a Windows proxy setting or antivirus filtering the app.

### Start does nothing
Look under the **Start** button for a red message — for example **"No camera selected"** (pick a camera at the top of the panel) or a missing API key.

### No output video / it lags
- Check your Xmax credits at [platform.xmax.ai](https://platform.xmax.ai).
- Close other apps and browser tabs, plug the laptop in and use a wired or strong Wi-Fi connection.

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
| `start.bat` | One-click launcher for Windows (checks Node, installs packages, starts the app) |

## Links

- [Xmax AI docs — Quickstart](https://platform.xmax.ai/docs/quick-start)
- [Xmax realtime SDK reference](https://platform.xmax.ai/docs/capabilities/realtime-video/sdk-reference)
