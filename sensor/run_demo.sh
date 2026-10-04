#!/usr/bin/env bash
# One-step demo launcher for Mac / Linux. No camera or other hardware needed.
#   bash sensor/run_demo.sh            click "Read bin" on the page for each reading
#   bash sensor/run_demo.sh --every 30 a new reading every 30 seconds
# First run creates sensor/.venv and installs the requirements (needs internet once).
set -e
cd "$(dirname "$0")/.."

PYTHON=python3
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "Python 3 is not installed. Get it from https://www.python.org/downloads/ and run this again."
  exit 1
fi

if [ ! -x sensor/.venv/bin/python ]; then
  echo "First run: setting up (about a minute)..."
  "$PYTHON" -m venv sensor/.venv
  sensor/.venv/bin/python -m pip install --quiet --upgrade pip
  sensor/.venv/bin/python -m pip install --quiet -r sensor/requirements.txt
fi

[ -f sensor/.env ] || cp sensor/.env.example sensor/.env

echo "Open http://localhost:8000/ in a browser. Press Ctrl+C here to stop."
exec sensor/.venv/bin/python sensor/bin_sensor.py demo "$@"
