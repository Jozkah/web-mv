@echo off
rem Launcher shipped inside the release folder. Starts the local server and opens the UI.
cd /d "%~dp0"

start "bun-server" bun-server.exe
rem Give the server a moment to bind before the browser requests the page.
timeout /t 1 /nobreak >nul
start "" http://127.0.0.1:9000/

echo echo-re is running at http://127.0.0.1:9000/
echo Close the "bun-server" window to stop the server.

