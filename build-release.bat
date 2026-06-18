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
echo === Assembling release\ ===
if exist release\public rmdir /s /q release\public
xcopy /E /I /Y frontend\dist release\public >nul || goto :err
copy /Y run.bat release\run.bat >nul || goto :err
copy /Y RELEASE-README.txt release\README.txt >nul || goto :err

echo.
echo Done. Ship the entire release\ folder (bun-server.exe + public\ + run.bat + README.txt),
echo then add your agent files as described in release\README.txt.
goto :eof

:err
echo.
echo BUILD FAILED
exit /b 1
