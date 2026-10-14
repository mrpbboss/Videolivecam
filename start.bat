@echo off
setlocal
title Videolivecam

rem Always run from the folder this file is in (double-click, shortcut, or "Run as admin")
cd /d "%~dp0"

echo ============================================
echo   Videolivecam
echo ============================================
echo.

rem ---- 1. Node.js installed? ----
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo.
  if exist "node-v24.13.0-x64.msi" (
    echo Install it with node-v24.13.0-x64.msi in this folder,
  ) else (
    echo Install it from https://nodejs.org ,
  )
  echo then restart your computer and run start.bat again.
  goto fail
)

for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] Node.js %NODE_VERSION% is too old. Version 18 or newer is required.
  echo Install the latest version from https://nodejs.org and try again.
  goto fail
)
echo [OK] Node.js %NODE_VERSION%

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js and make sure "Add to PATH" is ticked.
  goto fail
)

rem ---- 2. Packages installed? (first run, or the folder was copied without node_modules) ----
set "NEED_INSTALL="
if not exist "node_modules\.bin\electron.cmd" set "NEED_INSTALL=1"
if not exist "node_modules\next\package.json" set "NEED_INSTALL=1"
if not exist "node_modules\@xmaxai\sdk-global\package.json" set "NEED_INSTALL=1"

if defined NEED_INSTALL (
  echo.
  echo Installing packages for the first time. This needs internet and can take a few minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] Package install failed. Check your internet connection and try again.
    echo If it keeps failing, delete the node_modules folder and run start.bat again.
    goto fail
  )
)
echo [OK] Packages installed

rem ---- 3. Port 3000 free? ----
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo [WARNING] Port 3000 is already in use - the app may already be running,
  echo or another program is using it. Close it, or restart your computer, if the app doesn't open.
)

rem ---- 4. Launch ----
echo.
echo Starting the app... the window opens once the page has compiled (first start can take a minute).
echo Keep this window open while you use the app.
echo.
call npm run electron
if errorlevel 1 (
  echo.
  echo [ERROR] The app stopped with an error. See the messages above.
  goto fail
)
exit /b 0

:fail
echo.
pause
exit /b 1
