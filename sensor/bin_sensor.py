"""A real bin sensor: camera photo -> AI fill estimate -> telemetry row + live web page.

    python sensor/bin_sensor.py demo               # NO camera needed: replays the stored bin photos
    python sensor/bin_sensor.py demo --every 30    # ... a new reading every 30 s, like a deployed bin
    python sensor/bin_sensor.py watch              # live camera (Windows): each new photo is a reading
    python sensor/bin_sensor.py watch --every 20   # ... and fetch new photos by itself every 20 s
    python sensor/bin_sensor.py add-demo x.jpg 03_full   # store a photo (and its AI result) for demo mode
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

usb_disk = None  # the camera's USB drive control (Windows only); imported by watch()

CAPTURES = HERE / "captures"
DEMO_PHOTOS = HERE / "demo_photos"
DEMO_READINGS = DEMO_PHOTOS / "readings.json"
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


# What the watcher is doing, for the web page; `read_requested` is set by the page's button.
STATE = {"state": "starting", "message": "", "auto": False}
read_requested = threading.Event()


def set_state(state: str, message: str = "") -> None:
    STATE.update(state=state, message=message)


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
        # readings less than a minute apart (demos, retries) say nothing about the fill rate
        rate = 0.0 if collected or hours < 1 / 60 else round(change / hours, 3)
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
def read_photo(photo: pathlib.Path, bin_id: str, provider: str = "auto", source: str = "camera",
               cached: dict | None = None) -> dict | None:
    """One reading from one photo. `cached` is a stored AI result to use if no AI can be reached."""
    started = time.monotonic()
    try:
        if provider == "stored":
            raise RuntimeError("--provider stored: not calling any AI")
        estimate = estimate_fill(photo, provider)
    except Exception as ex:  # noqa: BLE001
        if cached is None:
            raise
        print(f"  (live AI unavailable, using the stored result for this photo: {str(ex)[:120]})")
        estimate = {**cached, "provider": "stored", "model": cached.get("model", "stored result")}
    seconds = time.monotonic() - started
    label = f"{estimate['provider']} {estimate['model']}"
    if not estimate["is_bin"]:
        print(f"  {photo.name}: not a bin ({estimate.get('reason')}) [{label}, {seconds:.1f} s]", flush=True)
        return None
    row = record(bin_id, estimate["fill_pct"], {
        "source": source, "confidence": estimate.get("confidence"), "reason": estimate.get("reason"),
        "ai_provider": estimate["provider"], "ai_model": estimate["model"], "photo": photo.name,
    }, photo)
    print(f"  {photo.name}: {row['fill_pct']}% full ({estimate.get('confidence')} confidence) [{label}, {seconds:.1f} s]")
    print(f"    why: {estimate.get('reason')}")
    print(f"    saved: {row['timestamp']} {bin_id} rate {row['fill_rate_pct_per_hr']} %/h"
          f"{'  (bin was emptied)' if row['collection_occurred'] else ''}", flush=True)
    return estimate


# ---------------------------------------------------------------- demo mode (no camera)
def demo_photos() -> list[pathlib.Path]:
    return sorted(DEMO_PHOTOS.glob("*.jpg"))


def stored_readings() -> dict:
    return json.loads(DEMO_READINGS.read_text()) if DEMO_READINGS.exists() else {}


def add_demo(photo: pathlib.Path, name: str, provider: str) -> None:
    """Copy a photo into demo_photos/ (shrunk) and store its AI result, so demo mode can replay it."""
    DEMO_PHOTOS.mkdir(exist_ok=True)
    target = DEMO_PHOTOS / f"{name}.jpg"
    target.write_bytes(small_jpeg(photo, longest=1280))
    estimate = estimate_fill(target, provider)
    readings = stored_readings()
    readings[target.name] = {k: estimate[k] for k in ("is_bin", "fill_pct", "confidence", "reason", "model")}
    DEMO_READINGS.write_text(json.dumps(readings, indent=2) + "\n")
    print(f"stored {target.name}: {estimate['fill_pct']}% full ({estimate['confidence']}): {estimate['reason']}")


def demo(bin_id: str, provider: str, every: float | None) -> None:
    """Replay the stored bin photos through the same pipeline as the live camera.

    Each "Read bin" click (or each `every` seconds) takes the next photo in demo_photos/, in
    file-name order, and sends it to the AI exactly as a fresh camera photo would be. Without an
    API key or internet it uses the AI result stored with the photo, so the demo cannot fail.
    """
    photos = demo_photos()
    if not photos:
        sys.exit(f"No photos in {DEMO_PHOTOS}. Add some with: bin_sensor.py add-demo photo.jpg 01_name")
    readings = stored_readings()
    STATE["auto"] = True
    print(f"Demo mode: {len(photos)} stored photo(s): {', '.join(p.name for p in photos)}")
    print("Click 'Read bin' on the page for the next reading" + (f", or wait {every:.0f} s." if every else "."))
    print("Ctrl+C to stop.", flush=True)
    set_state("idle", "")
    index = 0
    next_auto = time.monotonic() + every if every else None
    try:
        while True:
            due = next_auto is not None and time.monotonic() >= next_auto
            if read_requested.is_set() or due:
                read_requested.clear()
                photo = photos[index % len(photos)]
                index += 1
                set_state("fetching", "getting the photo from the camera")
                time.sleep(1.0)
                set_state("analyzing", "estimating the fill level")
                try:
                    read_photo(photo, bin_id, provider, source="demo_photo", cached=readings.get(photo.name))
                    set_state("idle", "")
                except Exception as ex:  # noqa: BLE001 - keep the demo alive
                    print(f"  {photo.name}: reading failed: {ex}", flush=True)
                    set_state("error", "the AI estimate failed")
                if every:
                    next_auto = time.monotonic() + every
            time.sleep(0.2)
    except KeyboardInterrupt:
        print()


def watch(bin_id: str, provider: str, every: float | None) -> None:
    """Turn every new photo on the camera's card into a reading.

    The card reaches the laptop in one of two ways: someone replugs the camera's USB 2.0 cable,
    or (with the DEBUG cable also connected) this script restarts the camera itself, on a
    "Read bin" click from the web page or every `every` seconds.
    """
    global usb_disk
    if sys.platform != "win32":
        sys.exit("Live camera mode only runs on Windows (it controls the camera's USB drive). "
                 "Use `demo` mode here: python sensor/bin_sensor.py demo")
    import usb_disk  # noqa: PLW0603

    CAPTURES.mkdir(exist_ok=True)
    seen: set[str] = set()
    first_pass = True
    can_restart = usb_disk.debug_port() is not None
    STATE["auto"] = can_restart
    if can_restart:
        print(f"Camera DEBUG port found ({usb_disk.debug_port()}): take a photo, then click 'Read bin' on the page"
              + (f" (or wait: checking every {every:.0f} s)." if every else "."))
        read_requested.set()  # index the photos already on the card
    else:
        print("Take a photo, then unplug and replug the camera's USB 2.0 cable. (Plug in the DEBUG cable too "
              "and restart this script to skip the replug.)")
    print("Ctrl+C to stop.", flush=True)

    was_loaded = False
    next_auto = time.monotonic() + every if every else None
    try:
        while True:
            if can_restart and not usb_disk.is_loaded():
                due = next_auto is not None and time.monotonic() >= next_auto
                if read_requested.is_set() or due:
                    read_requested.clear()
                    set_state("fetching", "getting the photo from the camera")
                    if not usb_disk.restart_camera():
                        print("  the camera did not come back after a restart (is it switched on?)", flush=True)
                        set_state("error", "camera did not respond")
                    if every:
                        next_auto = time.monotonic() + every
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
                local = None
                if fresh:  # only the newest: one reading per fetch
                    local = CAPTURES / f"{dt.datetime.now():%H%M%S}_{fresh[-1].name}"
                    shutil.copy2(fresh[-1], local)
                usb_disk.eject()  # give the camera back before the slow AI call
                if local is None:
                    set_state("idle", "no new photo on the camera")
                else:
                    set_state("analyzing", "estimating the fill level")
                    try:
                        read_photo(local, bin_id, provider)
                        set_state("idle", "")
                    except Exception as ex:  # noqa: BLE001 - keep watching
                        print(f"  {local.name}: reading failed: {ex}", flush=True)
                        set_state("error", "the AI estimate failed")
                print("  camera released: ready for the next photo", flush=True)
                loaded = usb_disk.is_loaded()
            was_loaded = loaded
            time.sleep(0.3)
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
        if path == "/api/status":
            self._send(json.dumps(STATE).encode(), "application/json")
        elif path == "/api/latest":
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


    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/api/read":
            read_requested.set()
            self._send(json.dumps({"requested": True, "auto": STATE["auto"]}).encode(), "application/json")
        else:
            self._send(b"not found", "text/plain", 404)

    def do_OPTIONS(self) -> None:  # noqa: N802 - CORS preflight for the frontend
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def serve(block: bool, port: int = PORT) -> None:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Live page: http://localhost:{port}/   API: http://localhost:{port}/api/latest", flush=True)
    if block:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print()
    else:
        threading.Thread(target=server.serve_forever, daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser(description="Bin fill sensor: ESP32-P4-EYE camera + AI vision.")
    parser.add_argument("mode", choices=["demo", "watch", "photo", "set", "serve", "add-demo"])
    parser.add_argument("value", nargs="?", help="photo path (photo / add-demo) or a percentage (set)")
    parser.add_argument("name", nargs="?", help="add-demo: name for the stored photo, e.g. 03_full")
    parser.add_argument("--bin", default="BIN_001", help="bin_id this sensor reports as (default BIN_001)")
    parser.add_argument("--provider", choices=["auto", "gemini", "nvidia", "stored"], default="auto",
                        help="which AI estimates the fill; 'stored' (demo mode) replays saved results with no AI call")
    parser.add_argument("--port", type=int, default=PORT, help=f"web page / API port (default {PORT})")
    parser.add_argument("--every", type=float, metavar="SECONDS",
                        help="demo / watch: take a new reading automatically at this interval")
    args = parser.parse_args()

    try:
        from dotenv import load_dotenv

        load_dotenv(HERE / ".env")
    except ImportError:
        pass

    if args.mode == "serve":
        set_state("idle", "")
        serve(block=True, port=args.port)
    elif args.mode == "set":
        row = record(args.bin, max(0, min(100, int(args.value))), {"source": "manual", "reason": "set by hand"}, None)
        print(f"manual reading saved: {row['timestamp']} {args.bin} {row['fill_pct']}%")
    elif args.mode == "add-demo":
        add_demo(pathlib.Path(args.value), args.name or pathlib.Path(args.value).stem, args.provider)
    elif args.mode == "demo":
        serve(block=False, port=args.port)
        demo(args.bin, args.provider, args.every)
    elif args.mode == "photo":
        read_photo(pathlib.Path(args.value), args.bin, args.provider)
    else:
        serve(block=False, port=args.port)
        watch(args.bin, args.provider, args.every)


if __name__ == "__main__":
    main()
