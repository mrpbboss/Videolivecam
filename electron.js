const { app, BrowserWindow, session } = require("electron");
const { spawn } = require("child_process");
const http = require("http");

let mainWindow;
let nextProcess;

const PORT = 3000;
const URL = `http://localhost:${PORT}`;

app.commandLine.appendSwitch("enable-media-stream");
app.commandLine.appendSwitch(
  "unsafely-treat-insecure-origin-as-secure",
  URL
);

function waitForServer(url, callback) {
  const tryRequest = () => {
    http
      .get(url, () => callback())
      .on("error", () => setTimeout(tryRequest, 500));
  };
  tryRequest();
}

function startNext() {
  const command = app.isPackaged ? "npm" : "npm";
  const args = app.isPackaged
    ? ["run", "start", "--", "-p", PORT]
    : ["run", "dev", "--", "-p", PORT];

  nextProcess = spawn(command, args, {
    shell: true,
    stdio: "inherit"
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0b0f17",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (permission === "media") callback(true);
      else callback(false);
    }
  );

  mainWindow.loadURL(URL);

  mainWindow.on("closed", () => {
    if (nextProcess) nextProcess.kill();
    app.quit();
  });
}

app.whenReady().then(() => {
  startNext();
  waitForServer(URL, createWindow);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (nextProcess) nextProcess.kill();
    app.quit();
  }
});
