"""A real bin sensor: camera photo -> Gemini fill estimate -> FREE-WILi gauge -> telemetry row.

    python sensor/bin_sensor.py watch              # live: every new camera photo becomes a reading
    python sensor/bin_sensor.py photo some.jpg     # one reading from a photo file
    python sensor/bin_sensor.py gauge 65           # just show 65% on the FREE-WILi (no camera, no AI)

Live use (camera on its "USB 2.0" port, switched on):
    1. the script ejects the camera's drive so the camera can shoot
    2. take a photo of the inside of the bin (shutter button)
    3. unplug and replug the camera cable: the drive comes back, the script reads the newest
       photo, estimates the fill level, shows it on the FREE-WILi and ejects again

Readings are appended to sensor/data/live_telemetry.csv in the same columns as
Flux_ReRoute_Synthetic_Data/telemetry_hourly.csv (with is_synthetic = False), and the most
recent one is also written to sensor/data/latest.json.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import pathlib
import shutil
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import usb_disk  # noqa: E402

CAPTURES = HERE / "captures"
DATA = HERE / "data"
TELEMETRY = DATA / "live_telemetry.csv"
LATEST = DATA / "latest.json"
COLUMNS = ["timestamp", "bin_id", "fill_pct", "fill_rate_pct_per_hr", "temperature_c_synthetic",
           "precipitation_mm_synthetic", "event_type", "event_attendance", "collection_occurred", "is_synthetic"]
NUM_LEDS = 7

PROMPT = """You are the vision part of a smart trash-bin sensor. The photo was taken by a camera
mounted above or inside a bin, looking at its contents.
Estimate how full the bin is, as a percentage of its usable volume: 0 = empty, 100 = full to
the rim or overflowing. Judge from how high the contents reach relative to the rim and walls.
If the photo does not show the inside of a bin, box or other container, set is_bin to false
and fill_pct to 0.
Reply with JSON only: {"is_bin": true or false, "fill_pct": integer 0-100,
"confidence": "low" or "medium" or "high", "reason": "one short sentence"}"""


# ---------------------------------------------------------------- vision
def estimate_fill(photo: pathlib.Path) -> dict:
    """Ask Gemini how full the bin in `photo` is. Returns the parsed JSON reply."""
    from google import genai
    from google.genai import types

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        sys.exit("Set GEMINI_API_KEY in sensor/.env")
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite"),
        contents=[types.Part.from_bytes(data=photo.read_bytes(), mime_type="image/jpeg"), PROMPT],
        config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0),
    )
    reply = json.loads(response.text)
    reply["fill_pct"] = max(0, min(100, int(reply.get("fill_pct", 0))))
    return reply


# ---------------------------------------------------------------- FREE-WILi gauge
class Gauge:
    """The FREE-WILi's 7 LEDs as a fill gauge, plus the percentage on its screen."""

    def __init__(self) -> None:
        self._fw = None
        try:
            from freewili import FreeWili

            found = FreeWili.find_first()
            if found.is_ok():
                self._fw = found.unwrap()
                self._fw.open().expect("could not open the FREE-WILi")
        except Exception as ex:  # noqa: BLE001 - the sensor still works without the gauge
            print(f"  (no FREE-WILi gauge: {ex})")
            self._fw = None
        if self._fw is None:
            print("  (FREE-WILi not found: readings will only be printed and saved)")

    @staticmethod
    def leds_for(fill_pct: int) -> tuple[int, tuple[int, int, int]]:
        """How many LEDs to light and in what colour: green below 50%, amber to 80%, red above."""
        lit = 0 if fill_pct <= 0 else max(1, min(NUM_LEDS, round(fill_pct * NUM_LEDS / 100)))
        color = (0, 50, 0) if fill_pct < 50 else (50, 30, 0) if fill_pct < 80 else (60, 0, 0)
        return lit, color

    def show(self, fill_pct: int, text: str | None = None) -> None:
        lit, color = self.leds_for(fill_pct)
        if self._fw is None:
            return
        for led in range(NUM_LEDS):
            self._fw.set_board_leds(led, *(color if led < lit else (0, 0, 0)))
        self._fw.show_text_display(text or f"{fill_pct}% full")

    def message(self, text: str) -> None:
        if self._fw is not None:
            self._fw.show_text_display(text)

    def close(self) -> None:
        if self._fw is not None:
            self._fw.close()


# ---------------------------------------------------------------- telemetry
def last_reading(bin_id: str) -> dict | None:
    if not TELEMETRY.exists():
        return None
    with TELEMETRY.open(newline="") as handle:
        rows = [row for row in csv.DictReader(handle) if row["bin_id"] == bin_id]
    return rows[-1] if rows else None


def record(bin_id: str, fill_pct: int, estimate: dict, photo: pathlib.Path) -> dict:
    """Append one reading in the teammates' telemetry format and refresh latest.json."""
    DATA.mkdir(exist_ok=True)
    now = dt.datetime.now().replace(microsecond=0)
    previous = last_reading(bin_id)
    rate, collected = 0.0, False
    if previous:
        hours = (now - dt.datetime.fromisoformat(previous["timestamp"])).total_seconds() / 3600
        change = fill_pct - float(previous["fill_pct"])
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
    LATEST.write_text(json.dumps({**row, "sensor_provider": "freewili_esp32_p4_eye", "photo": photo.name,
                                  "confidence": estimate.get("confidence"), "reason": estimate.get("reason")}, indent=2))
    return row


# ---------------------------------------------------------------- one reading
def read_photo(photo: pathlib.Path, bin_id: str, gauge: Gauge) -> None:
    gauge.message("looking")
    started = time.monotonic()
    estimate = estimate_fill(photo)
    seconds = time.monotonic() - started
    if not estimate.get("is_bin"):
        print(f"  {photo.name}: not a bin ({estimate.get('reason')}) [{seconds:.1f} s]")
        gauge.message("no bin")
        return
    fill = estimate["fill_pct"]
    row = record(bin_id, fill, estimate, photo)
    gauge.show(fill)
    lit, _ = Gauge.leds_for(fill)
    print(f"  {photo.name}: {fill}% full ({estimate.get('confidence')} confidence) [{seconds:.1f} s]")
    print(f"    why: {estimate.get('reason')}")
    print(f"    gauge: {lit} of {NUM_LEDS} LEDs   saved: {row['timestamp']} {bin_id} "
          f"rate {row['fill_rate_pct_per_hr']} %/h{'  (bin was emptied)' if row['collection_occurred'] else ''}")


def watch(bin_id: str, gauge: Gauge) -> None:
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
                    read_photo(local, bin_id, gauge)
                usb_disk.eject()
                print("  camera released: ready for the next photo", flush=True)
                loaded = usb_disk.is_loaded()
            was_loaded = loaded
            time.sleep(0.5)
    except KeyboardInterrupt:
        print()


def main() -> None:
    parser = argparse.ArgumentParser(description="Bin fill sensor: ESP32-P4-EYE camera + Gemini + FREE-WILi gauge.")
    parser.add_argument("mode", choices=["watch", "photo", "gauge"])
    parser.add_argument("value", nargs="?", help="photo path (photo mode) or a percentage (gauge mode)")
    parser.add_argument("--bin", default="BIN_001", help="bin_id this sensor reports as (default BIN_001)")
    args = parser.parse_args()

    try:
        from dotenv import load_dotenv

        load_dotenv(HERE / ".env")
    except ImportError:
        pass

    gauge = Gauge()
    try:
        if args.mode == "gauge":
            gauge.show(int(args.value))
            print(f"gauge set to {args.value}%: {Gauge.leds_for(int(args.value))[0]} of {NUM_LEDS} LEDs")
        elif args.mode == "photo":
            read_photo(pathlib.Path(args.value), args.bin, gauge)
        else:
            watch(args.bin, gauge)
    finally:
        gauge.close()


if __name__ == "__main__":
    main()
