@echo off
cd /d "%~dp0"

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
)

set DOTENV_CONFIG_PATH=.env.bot1
echo Starting Bot1...
call npm run dev
pause
