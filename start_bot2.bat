@echo off
cd /d "%~dp0"

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
)

set DOTENV_CONFIG_PATH=.env.bot2
echo Starting Bot2...
call npm run dev
pause
