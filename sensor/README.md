# Bin sensor (hardware)

A real trash-can sensor for the Flux / ReRoute prototype. A camera looks into a bin, an AI
vision model estimates how full it is, and the reading is published in the same shape as
`Flux_ReRoute_Synthetic_Data/telemetry_hourly.csv` (`is_synthetic = False`).

Lives on the `hardware` branch. `main` is untouched.

## Run it
```bash
py -V:3.12 -m venv sensor\.venv
sensor\.venv\Scripts\python.exe -m pip install -r sensor\requirements.txt
# put GEMINI_API_KEY and NVIDIA_API_KEY in sensor\.env  (never commit it)

sensor\.venv\Scripts\python.exe sensor\bin_sensor.py watch          # live readings + web page
sensor\.venv\Scripts\python.exe sensor\bin_sensor.py photo x.jpg    # one reading from a file
sensor\.venv\Scripts\python.exe sensor\bin_sensor.py set 80         # manual reading for a demo
sensor\.venv\Scripts\python.exe sensor\bin_sensor.py serve          # web page / API only
```

## For the frontend
While `watch` or `serve` runs (CORS is open):
| URL | Returns |
|---|---|
| `http://localhost:8000/` | a small live page: fill level, photo, recent readings |
| `http://localhost:8000/api/latest` | newest reading as JSON (`null` before the first one) |
| `http://localhost:8000/api/history` | every reading so far, as a JSON list |
| `http://localhost:8000/photo/latest.jpg` | the photo behind the newest reading |

`/api/latest` example:
```json
{
  "timestamp": "2026-10-04 01:54:14", "bin_id": "BIN_001", "fill_pct": 10,
  "fill_rate_pct_per_hr": 0.0, "event_type": "none", "event_attendance": 0,
  "collection_occurred": false, "is_synthetic": false,
  "sensor_provider": "esp32_p4_eye_camera", "has_photo": true,
  "source": "camera", "confidence": "high",
  "reason": "The trash bin contains only a couple of small cups at the bottom.",
  "ai_provider": "gemini", "ai_model": "gemini-3.5-flash-lite"
}
```
`source` is `"camera"` for a real photo and `"manual"` for `set`. The same rows are appended to
`sensor/data/live_telemetry.csv` (git-ignored) with the synthetic data's column names.
`collection_occurred` becomes true when the fill drops by 30 points or more.

## How a reading happens
Plug **both** camera ports into the laptop: "USB 2.0" (photos) and "DEBUG" (control).
1. Take a photo of the inside of the bin with the camera's shutter button.
2. Click **Read bin** on the page (or `POST /api/read`, or run `watch --every 20` to fetch on a timer).
3. The script restarts the camera through the DEBUG port; about 4 s later its card appears as
   drive `D:`. The newest photo is copied and the card is handed straight back to the camera.
4. The photo is shrunk and sent to Gemini; if Gemini fails, to NVIDIA NIM
   (`meta/llama-3.2-90b-vision-instruct`).
5. The reading is saved and published. `GET /api/status` reports `fetching` / `analyzing` / `idle`.

With only the USB 2.0 cable connected it still works, but step 2 becomes "unplug and replug
that cable".

## Verified (Sun Oct 4, ~2 AM)
- A real trash can photo gave **10% full** from both providers (Gemini 3.8 s, NVIDIA 8.8 s).
- With a deliberately wrong Gemini key, the reading came from NVIDIA automatically.
- The live page shows the reading and the photo.
- With both cables connected, restarting the camera from the laptop brings the card back in
  3.8 s, twice in a row, and the page's Read bin button runs the whole cycle with no replug.
Not verified: fuller bins, poor lighting, and a full button-triggered reading of a brand-new
photo (the button was only clicked with no new photo on the card).

## The camera
A stock Espressif **ESP32-P4-EYE in its case**, running Espressif's camera firmware.
- Power switch must be on **I**.
- **"USB 2.0" port -> laptop:** its card appears as a 2 GB FAT drive (`D:`, VID 303A PID 4002) with
  photos in `D:\esp32_p4_pic_save`. While the drive is loaded the camera shows "functions are
  disabled in USB disk mode" and will not shoot.
- `python sensor/usb_disk.py eject` releases the card from the laptop side; the camera resumes.
- Getting the drive back needs a replug: the camera ignores a load request
  (`IOCTL_STORAGE_LOAD_MEDIA` -> "device not ready"), and re-enumerating the USB device from
  software needs administrator rights.
- **"DEBUG" port -> laptop:** the camera runs normally; the laptop gets a control port
  (`COM13` here, VID 303A PID 1001). It prints no log lines, but it can restart the camera:
  clear DTR, assert RTS for 0.2 s, release RTS (`usb_disk.restart_camera`). After a restart
  with the USB 2.0 cable connected, the camera comes up in USB disk mode.
- The laptop cannot press the shutter. A person does, or the camera's interval (time-lapse)
  mode could (not tried, and a restart probably leaves that mode).

## What was dropped
The FREE-WILi is no longer part of this. It was only showing the result on its LEDs, and its
WILEye camera link needs an adapter board that is not in the kit (chaining the camera through
the Bottlenose Orca's USB-C does nothing: every port in that chain is a USB device port).
