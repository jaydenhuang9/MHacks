"""A real bin sensor: camera photo -> AI fill estimate -> telemetry row + live web page.

    python sensor/bin_sensor.py watch              # live: every new camera photo becomes a reading
    python sensor/bin_sensor.py photo some.jpg     # one reading from a photo file
    python sensor/bin_sensor.py set 80             # a manual reading (for demos; marked as manual)
    python sensor/bin_sensor.py serve              # only the web page / API

While `watch` or `serve` runs:
    http://localhost:8000/             live page (fill level, photo, history)
    http://localhost:8000/api/latest   the newest reading as JSON  (CORS open, for the frontend)
    http://localhost:8000/api/history  every reading so far as JSON

Readings are appended to sensor/data/live_telemetry.csv in the same columns as
Flux_ReRoute_Synthetic_Data/telemetry_hourly.csv (with is_synthetic = False), and the most
recent one is written to sensor/data/latest.json.

The fill estimate comes from Gemini; if Gemini fails (rate limit, outage) it falls back to an
NVIDIA NIM vision model. Keys go in sensor/.env (GEMINI_API_KEY, NVIDIA_API_KEY).
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import http.server
import io
import json
import os
import pathlib
import re
import shutil
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import usb_disk  # noqa: E402

CAPTURES = HERE / "captures"
DATA = HERE / "data"
WEB = HERE / "web"
TELEMETRY = DATA / "live_telemetry.csv"
LATEST = DATA / "latest.json"
LATEST_PHOTO = DATA / "latest.jpg"
COLUMNS = ["timestamp", "bin_id", "fill_pct", "fill_rate_pct_per_hr", "temperature_c_synthetic",
           "precipitation_mm_synthetic", "event_type", "event_attendance", "collection_occurred", "is_synthetic"]
PORT = 8000
NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
NVIDIA_MODEL = "meta/llama-3.2-90b-vision-instruct"

PROMPT = """You are the vision part of a smart trash-bin sensor. The photo was taken by a camera
looking into a bin at its contents.
Estimate how full the bin is, as a percentage of its usable volume: 0 = empty, 100 = full to
the rim or overflowing. Judge from how high the contents reach relative to the rim and walls.
If the photo does not show the inside of a bin, box or other container, set is_bin to false
and fill_pct to 0.
Reply with JSON only: {"is_bin": true or false, "fill_pct": integer 0-100,
"confidence": "low" or "medium" or "high", "reason": "one short sentence"}"""


# ---------------------------------------------------------------- vision
def small_jpeg(photo: pathlib.Path, longest: int = 768) -> bytes:
    """The photo shrunk for upload: faster, and under NVIDIA's inline image size limit."""
    from PIL import Image

    image = Image.open(photo).convert("RGB")
    image.thumbnail((longest, longest))
    out = io.BytesIO()
    image.save(out, "JPEG", quality=80)
    return out.getvalue()


def _parse(text: str) -> dict:
    found = re.search(r"\{.*\}", text, re.DOTALL)  # tolerate code fences or prose around the JSON
    reply = json.loads(found.group(0) if found else text)
    reply["fill_pct"] = max(0, min(100, int(float(reply.get("fill_pct", 0)))))
    reply["is_bin"] = bool(reply.get("is_bin"))
    return reply


def ask_gemini(jpeg: bytes) -> dict:
    from google import genai
    from google.genai import types

    model = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    response = client.models.generate_content(
        model=model,
        contents=[types.Part.from_bytes(data=jpeg, mime_type="image/jpeg"), PROMPT],
        config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0),
    )
    return {**_parse(response.text), "model": model}


def ask_nvidia(jpeg: bytes) -> dict:
    import requests

    model = os.environ.get("NVIDIA_MODEL", NVIDIA_MODEL)
    image = base64.b64encode(jpeg).decode()
    response = requests.post(
        NVIDIA_URL,
        headers={"Authorization": f"Bearer {os.environ['NVIDIA_API_KEY']}", "Accept": "application/json"},
        json={
            "model": model,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image}"}},
            ]}],
            "max_tokens": 200,
            "temperature": 0,
        },
        timeout=60,
    )
    response.raise_for_status()
    return {**_parse(response.json()["choices"][0]["message"]["content"]), "model": model}


PROVIDERS = {"gemini": ("GEMINI_API_KEY", ask_gemini), "nvidia": ("NVIDIA_API_KEY", ask_nvidia)}


def estimate_fill(photo: pathlib.Path, provider: str = "auto") -> dict:
    """How full is the bin in `photo`? Tries Gemini, then NVIDIA, unless one provider is forced."""
    jpeg = small_jpeg(photo)
    order = ["gemini", "nvidia"] if provider == "auto" else [provider]
    errors = []
    for name in order:
        key, ask = PROVIDERS[name]
        if not os.environ.get(key):
            errors.append(f"{name}: {key} is not set")
            continue
        try:
            return {**ask(jpeg), "provider": name}
        except Exception as ex:  # noqa: BLE001 - fall through to the backup provider
            errors.append(f"{name}: {type(ex).__name__}: {str(ex)[:160]}")
            print(f"  ({errors[-1]})")
    raise RuntimeError("no AI provider answered: " + " | ".join(errors))


# ---------------------------------------------------------------- telemetry
def history() -> list[dict]:
    if not TELEMETRY.exists():
        return []
    with TELEMETRY.open(newline="") as handle:
        return list(csv.DictReader(handle))


def record(bin_id: str, fill_pct: int, extra: dict, photo: pathlib.Path | None) -> dict:
    """Append one reading in the teammates' telemetry format and refresh latest.json."""
    DATA.mkdir(exist_ok=True)
    now = dt.datetime.now().replace(microsecond=0)
    earlier = [row for row in history() if row["bin_id"] == bin_id]
    rate, collected = 0.0, False
    if earlier:
        hours = (now - dt.datetime.fromisoformat(earlier[-1]["timestamp"])).total_seconds() / 3600
        change = fill_pct - float(earlier[-1]["fill_pct"])
        collected = change <= -30  # a big drop means the bin was emptied
        rate = 0.0 if collected or hours <= 0 else round(change / hours, 3)
    row = {
        "timestamp": now.isoformat(sep=" "), "bin_id": bin_id, "fill_pct": fill_pct,
        "fill_rate_pct_per_hr": rate, "temperature_c_synthetic": "", "precipitation_mm_synthetic": "",
        "event_type": "none", "event_attendance": 0, "collection_occurred": collected, "is_synthetic": False,
    }
    new_file = not TELEMETRY.exists()
    with TELEMETRY.open("a", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        if new_file:
            writer.writeheader()
        writer.writerow(row)
    if photo is not None:
        LATEST_PHOTO.write_bytes(small_jpeg(photo, longest=960))
    elif LATEST_PHOTO.exists():
        LATEST_PHOTO.unlink()
    LATEST.write_text(json.dumps({**row, "sensor_provider": "esp32_p4_eye_camera", "has_photo": photo is not None,
                                  **extra}, indent=2))
    return row


# ---------------------------------------------------------------- one reading
def read_photo(photo: pathlib.Path, bin_id: str, provider: str = "auto") -> None:
    started = time.monotonic()
    estimate = estimate_fill(photo, provider)
    seconds = time.monotonic() - started
    source = f"{estimate['provider']} {estimate['model']}"
    if not estimate["is_bin"]:
        print(f"  {photo.name}: not a bin ({estimate.get('reason')}) [{source}, {seconds:.1f} s]", flush=True)
        return
    row = record(bin_id, estimate["fill_pct"], {
        "source": "camera", "confidence": estimate.get("confidence"), "reason": estimate.get("reason"),
        "ai_provider": estimate["provider"], "ai_model": estimate["model"], "photo": photo.name,
    }, photo)
    print(f"  {photo.name}: {row['fill_pct']}% full ({estimate.get('confidence')} confidence) [{source}, {seconds:.1f} s]")
    print(f"    why: {estimate.get('reason')}")
    print(f"    saved: {row['timestamp']} {bin_id} rate {row['fill_rate_pct_per_hr']} %/h"
          f"{'  (bin was emptied)' if row['collection_occurred'] else ''}", flush=True)


def watch(bin_id: str, provider: str) -> None:
    """Turn every new photo on the camera's card into a reading."""
    CAPTURES.mkdir(exist_ok=True)
    seen: set[str] = set()
    first_pass = True
    print("Watching the camera. Take a photo, then unplug and replug its USB 2.0 cable. Ctrl+C to stop.")
    was_loaded = False
    try:
        while True:
            loaded = usb_disk.is_loaded()
            if loaded and not was_loaded:
                time.sleep(1.0)  # let Windows finish mounting the card
                photos = usb_disk.photos()
                fresh = [p for p in photos if p.name not in seen]
                seen.update(p.name for p in photos)
                if first_pass:
                    print(f"  camera card has {len(photos)} photo(s) already; waiting for a new one")
                    fresh = []
                first_pass = False
                for photo in fresh[-1:]:  # only the newest: one reading per replug
                    local = CAPTURES / f"{dt.datetime.now():%H%M%S}_{photo.name}"
                    shutil.copy2(photo, local)
                    try:
                        read_photo(local, bin_id, provider)
                    except Exception as ex:  # noqa: BLE001 - keep watching
                        print(f"  {photo.name}: reading failed: {ex}", flush=True)
                usb_disk.eject()
                print("  camera released: ready for the next photo", flush=True)
                loaded = usb_disk.is_loaded()
            was_loaded = loaded
            time.sleep(0.5)
    except KeyboardInterrupt:
        print()


# ---------------------------------------------------------------- web page + API
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # keep the terminal for readings
        pass

    def _send(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - http.server's naming
        path = self.path.split("?")[0]
        if path == "/api/latest":
            body = LATEST.read_bytes() if LATEST.exists() else b"null"
            self._send(body, "application/json")
        elif path == "/api/history":
            self._send(json.dumps(history()).encode(), "application/json")
        elif path == "/photo/latest.jpg" and LATEST_PHOTO.exists():
            self._send(LATEST_PHOTO.read_bytes(), "image/jpeg")
        elif path in ("/", "/index.html"):
            self._send((WEB / "index.html").read_bytes(), "text/html; charset=utf-8")
        else:
            self._send(b"not found", "text/plain", 404)


def serve(block: bool) -> None:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Live page: http://localhost:{PORT}/   API: http://localhost:{PORT}/api/latest", flush=True)
    if block:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print()
    else:
        threading.Thread(target=server.serve_forever, daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser(description="Bin fill sensor: ESP32-P4-EYE camera + AI vision.")
    parser.add_argument("mode", choices=["watch", "photo", "set", "serve"])
    parser.add_argument("value", nargs="?", help="photo path (photo mode) or a percentage (set mode)")
    parser.add_argument("--bin", default="BIN_001", help="bin_id this sensor reports as (default BIN_001)")
    parser.add_argument("--provider", choices=["auto", "gemini", "nvidia"], default="auto")
    args = parser.parse_args()

    try:
        from dotenv import load_dotenv

        load_dotenv(HERE / ".env")
    except ImportError:
        pass

    if args.mode == "serve":
        serve(block=True)
    elif args.mode == "set":
        row = record(args.bin, max(0, min(100, int(args.value))), {"source": "manual", "reason": "set by hand"}, None)
        print(f"manual reading saved: {row['timestamp']} {args.bin} {row['fill_pct']}%")
    elif args.mode == "photo":
        read_photo(pathlib.Path(args.value), args.bin, args.provider)
    else:
        serve(block=False)
        watch(args.bin, args.provider)


if __name__ == "__main__":
    main()
