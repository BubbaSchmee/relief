@echo off
title RELIEF
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, first run only...
  call pnpm install || goto fail
)
echo Building RELIEF...
call pnpm build:app || goto fail
node scripts\serve.mjs
goto :eof
:fail
echo.
echo Something went wrong. RELIEF needs Node.js and pnpm installed.
pause
