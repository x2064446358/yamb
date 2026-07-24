@echo off
cd /d "%~dp0"

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
)

set DOTENV_CONFIG_PATH=.env.bot3
echo Starting Bot3...
call npm run dev
pause
