@echo off
rem Build a self-contained release into release\. Requires Bun installed on THIS machine
rem (end users will not need it - the output is a standalone exe). Run from a normal shell:
rem     build-release.bat
setlocal
cd /d "%~dp0"

echo === Building frontend (static UI) ===
pushd frontend
call bun install || goto :err
call bun run build || goto :err
popd

if not exist release mkdir release

echo.
echo === Compiling relay into a standalone exe ===
pushd relay
call bun install || goto :err
call bun run compile || goto :err
popd

echo.
echo === Verifying the compiled server carries the /agent-ext route ===
rem The WRITE lane connects to ws://.../agent-ext. If a build ever ships without
rem that route the lane silently 404s ("ws upgrade failed"). Byte-grep the exe and
rem fail the build here rather than discover it live. (This exact drift happened
rem once: a stale exe predated the route — see dev-run.ps1 banner.)
findstr /m /c:"agent-ext" release\bun-server.exe >nul || goto :err_route

echo.
echo === Assembling release\ ===
if exist release\public rmdir /s /q release\public
xcopy /E /I /Y frontend\dist release\public >nul || goto :err
copy /Y run.bat release\run.bat >nul || goto :err
copy /Y RELEASE-README.txt release\README.txt >nul || goto :err

echo.
echo Done. Ship the entire release\ folder (bun-server.exe + public\ + run.bat + README.txt),
echo then add your agent files as described in release\README.txt.
goto :eof

:err_route
echo.
echo BUILD FAILED: release\bun-server.exe does not contain the /agent-ext route.
echo The relay source or the compile step is broken/stale. Do NOT ship this exe.
exit /b 1

:err
echo.
echo BUILD FAILED
exit /b 1
