# Bin sensor (hardware)

A real trash-can sensor for the Flux / ReRoute prototype. A camera looks into a bin, an AI
vision model estimates how full it is, and the reading is published in the same shape as
`Flux_ReRoute_Synthetic_Data/telemetry_hourly.csv` (with `is_synthetic = False`).

Everything here is on the `hardware` branch, in the `sensor/` folder. `main` is untouched.

---

## Demo on any laptop (Mac or Windows, no camera needed)

This is the mode for judging. It replays real photos taken by the bin camera through the same
pipeline as the live camera. Needs Python 3.10 or newer.

**Mac / Linux**
```bash
git checkout hardware
python3 -m venv sensor/.venv
sensor/.venv/bin/python -m pip install -r sensor/requirements.txt
cp sensor/.env.example sensor/.env        # then paste a Gemini key into it (optional, see below)
sensor/.venv/bin/python sensor/bin_sensor.py demo
```

**Windows**
```bash
git checkout hardware
py -m venv sensor\.venv
sensor\.venv\Scripts\python.exe -m pip install -r sensor\requirements.txt
copy sensor\.env.example sensor\.env
sensor\.venv\Scripts\python.exe sensor\bin_sensor.py demo
```

Then open **http://localhost:8000/** and click **Read bin**. Each click takes the next stored
photo (in `sensor/demo_photos/`, in file-name order), estimates its fill level and updates the
page. Add `--every 30` to get a new reading every 30 seconds without clicking.

**API key:** with a `GEMINI_API_KEY` in `sensor/.env` (free, 2 minutes:
https://aistudio.google.com/apikey) the AI really analyses the photo live, in about 4 to 9
seconds. With no key, or no internet, the demo automatically uses the AI result that was saved
with each photo, so it cannot fail on stage. To force that and get identical numbers every
time, run `demo --provider stored`.

**If port 8000 is taken:** add `--port 8010` and open that port instead.

### What to say, and what not to claim
- True: "A camera in the bin takes a photo, an AI vision model estimates how full it is, and
  that reading feeds the same data the pickup planner uses." These are real photos from our
  camera (an ESP32-P4-EYE) of real bins, and the estimate is a real AI call.
- True: "In a deployment it would take a photo on a schedule, say every 30 minutes."
  `--every 30` shows the idea with a shorter gap.
- Say plainly if asked: in this demo the photos are **stored and replayed**; the page labels each
  reading "stored photo, replayed". With the camera attached (below) the photo is live.
- Do not claim the fill number is exact. It is an estimate from one photo: good enough to rank
  which bins to visit. The same photo can come back a few points different between runs.
- Do not claim the camera is triggered by software. With its stock firmware a person presses
  the shutter; scheduled capture would use the camera's own interval mode.

---

## For the frontend
While `demo`, `watch` or `serve` runs (CORS is open, so a page on another port can call these):
| Request | Returns |
|---|---|
| `GET http://localhost:8000/api/latest` | newest reading as JSON (`null` before the first one) |
| `GET http://localhost:8000/api/history` | every reading so far, as a JSON list |
| `GET http://localhost:8000/api/status` | `{"state": "idle" / "fetching" / "analyzing" / "error", "message": ..., "auto": true}` |
| `POST http://localhost:8000/api/read` | asks for a new reading (same as the Read bin button) |
| `GET http://localhost:8000/photo/latest.jpg` | the photo behind the newest reading |
| `GET http://localhost:8000/` | a small ready-made live page (`sensor/web/index.html`) |

`/api/latest` example:
```json
{
  "timestamp": "2026-10-04 01:54:14", "bin_id": "BIN_001", "fill_pct": 10,
  "fill_rate_pct_per_hr": 0.0, "event_type": "none", "event_attendance": 0,
  "collection_occurred": false, "is_synthetic": false,
  "sensor_provider": "esp32_p4_eye_camera", "has_photo": true,
  "source": "camera", "confidence": "high",
  "reason": "The trash bin contains only a couple of small cups at the bottom.",
  "ai_provider": "gemini", "ai_model": "gemini-3.5-flash-lite", "photo": "pic_6.jpg"
}
```
- `source`: `"camera"` (live photo), `"demo_photo"` (stored photo replayed) or `"manual"` (`set`).
- `ai_provider`: `"gemini"`, `"nvidia"`, or `"stored"` when a saved result was used.
- Column names match the synthetic telemetry; use `--bin BIN_007` to report as another bin.
- `collection_occurred` turns true when the fill drops by 30 points or more.
- The same rows are appended to `sensor/data/live_telemetry.csv` (git-ignored).

Minimal use from any page:
```js
const reading = await (await fetch("http://localhost:8000/api/latest")).json();
if (reading) console.log(reading.bin_id, reading.fill_pct);
```

## All commands
```text
bin_sensor.py demo [--every N] [--provider stored]   replay stored photos (any OS)
bin_sensor.py watch [--every N]                      live camera (Windows only)
bin_sensor.py photo x.jpg                            one reading from any photo file
bin_sensor.py set 80                                 a manual reading, labelled as manual
bin_sensor.py add-demo x.jpg 03_full                 store a photo + its AI result for demo mode
bin_sensor.py serve                                  web page / API only
common options: --bin BIN_001   --port 8000   --provider auto|gemini|nvidia|stored
```

---

## Live camera (Windows only)
The camera is a stock Espressif **ESP32-P4-EYE in its case**, running Espressif's firmware.
Power switch on **I**. Plug **both** of its USB-C ports into the laptop: "USB 2.0" (photos) and
"DEBUG" (control). Then run `bin_sensor.py watch`.

1. Take a photo of the inside of the bin with the camera's shutter button.
2. Click **Read bin** on the page (or `POST /api/read`, or use `watch --every 20`).
3. The script restarts the camera through the DEBUG port; about 4 s later its card appears as
   drive `D:`. The newest photo is copied and the card is handed straight back to the camera.
4. The photo is shrunk and sent to Gemini; if Gemini fails, to NVIDIA NIM
   (`meta/llama-3.2-90b-vision-instruct`).
5. The reading is saved and published.

With only the USB 2.0 cable connected it still works, but step 2 becomes "unplug and replug
that cable".

How the camera behaves (measured):
- **"USB 2.0" port:** its card appears as a 2 GB FAT drive (`D:`, VID 303A PID 4002) with photos
  in `D:\esp32_p4_pic_save`. While the drive is loaded the camera shows "functions are disabled
  in USB disk mode" and will not shoot. `usb_disk.py eject` releases it from the laptop side.
- The camera ignores a request to load the card again, so getting it back needs either a
  replug or a restart.
- **"DEBUG" port:** a control port (`COM13` here, VID 303A PID 1001). It prints no log lines, but
  it can restart the camera: clear DTR, assert RTS for 0.2 s, release RTS
  (`usb_disk.restart_camera`). After a restart with the USB 2.0 cable in, the camera comes up in
  USB disk mode.
- The laptop cannot press the shutter. The camera's menu has an interval (time-lapse) mode,
  not tried.
- This mode is Windows-only because `usb_disk.py` uses Windows calls to eject the drive. It
  expects the drive letter `D:`; change `DRIVE` at the top of `usb_disk.py` if yours differs.

## Verified (Sun Oct 4, about 2 AM)
- A real trash can photo gave **10% full** from both providers (Gemini 3.8 s, NVIDIA 8.8 s).
  A later run on the same photo gave 5%, so expect a few points of variation.
- With a deliberately wrong Gemini key, the reading came from NVIDIA automatically.
- Demo mode produced a reading with live AI, and with no keys at all it used the stored result.
- With both cables connected, restarting the camera from the laptop brings the card back in
  3.8 s, twice in a row, and the Read bin button runs the whole cycle with no replug.

Not verified: demo mode on a Mac (it was written to be portable but only run on Windows),
poor lighting, and a button-triggered live reading of a brand-new photo.

## What was dropped
A FREE-WILi was part of the first version (LED fill gauge). It was removed because it only
displayed the result, and its own camera link needs an adapter board that was not in the kit.
