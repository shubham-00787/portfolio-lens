#!/usr/bin/env bash
# Start Portfolio Lens on http://localhost:8765
set -e
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }
# --no-access-log: request URLs contain fund names / ISINs, so they are not logged.
exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "${PORT:-8765}" --no-access-log "$@"
