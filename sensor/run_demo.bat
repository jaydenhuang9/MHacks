@echo off
rem One-step demo launcher for Windows. No camera or other hardware needed.
rem   sensor\run_demo.bat              click "Read bin" on the page for each reading
rem   sensor\run_demo.bat --every 30   a new reading every 30 seconds
rem First run creates sensor\.venv and installs the requirements (needs internet once).
cd /d "%~dp0.."

if not exist sensor\.venv\Scripts\python.exe (
  echo First run: setting up ^(about a minute^)...
  py -3 -m venv sensor\.venv 2>nul || python -m venv sensor\.venv
  if not exist sensor\.venv\Scripts\python.exe (
    echo Python 3 is not installed. Get it from https://www.python.org/downloads/ and run this again.
    exit /b 1
  )
  sensor\.venv\Scripts\python.exe -m pip install --quiet --upgrade pip
  sensor\.venv\Scripts\python.exe -m pip install --quiet -r sensor\requirements.txt
)

if not exist sensor\.env copy sensor\.env.example sensor\.env >nul

echo Open http://localhost:8000/ in a browser. Press Ctrl+C here to stop.
sensor\.venv\Scripts\python.exe sensor\bin_sensor.py demo %*
