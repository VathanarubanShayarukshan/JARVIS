@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
    echo Creating virtualenv and installing dependencies...
    python -m venv .venv
    .venv\Scripts\pip install -r requirements.txt
)
echo Starting AgenticAI at http://localhost:8000  (Ctrl+C to stop)
.venv\Scripts\python.exe -m app.main