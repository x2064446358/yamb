@echo off
setlocal
cd /d "%~dp0"

set "BOT_NUMBER=%~1"
if "%BOT_NUMBER%"=="" set "BOT_NUMBER=1"
set "ENV_FILE=.env.bot%BOT_NUMBER%"

if not exist "%ENV_FILE%" (
  echo Missing %ENV_FILE%.
  echo Create that file from .env.example before starting the bot.
  exit /b 1
)

if not exist "node_modules\" (
  call npm install
  if errorlevel 1 exit /b 1
)

echo Starting Bot%BOT_NUMBER% with %ENV_FILE%...
start "YAMB Bot %BOT_NUMBER%" /D "%~dp0" powershell -NoExit -Command ^
  "chcp 65001 ^> `$null; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::InputEncoding = [Text.Encoding]::UTF8; `$env:DOTENV_CONFIG_PATH='%ENV_FILE%'; npm run dev"

endlocal
