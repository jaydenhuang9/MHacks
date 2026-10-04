# Bin sensor (hardware)

A real trash-can sensor for the Flux / ReRoute prototype, built on a FREE-WILi 1 and its
WILEye camera (an Espressif ESP32-P4-EYE with FREE-WILi firmware). Goal: one real bin that
reports its fill level in the same shape as `Flux_ReRoute_Synthetic_Data/telemetry_hourly.csv`
(`timestamp, bin_id, fill_pct`, with `is_synthetic = False`).

Status: work in progress on the `hardware` branch. Nothing here is verified yet except that the
FREE-WILi answers on the older firmware.

## Setup
```bash
py -V:3.12 -m venv sensor\.venv
sensor\.venv\Scripts\python.exe -m pip install -r sensor\requirements.txt
```

## Hardware state
- FREE-WILi **FW5171** runs the older ("deprecated") firmware, main v92 / display v67, because
  the WILEye camera commands only exist there. It is driven by the `freewili` pip package.
- FREE-WILi **FW4551** runs OG firmware v024 (driven by the `onewili` package). Its
  accelerometer stream works, so it can be a lid sensor and LED gauge.
- The flashing tool is in `C:\Users\yk101\MHacks-2026\.tools` (`fwogcli.exe`); firmware notes are
  in that repo's `CLAUDE.md`.

## The camera in hand
A stock Espressif **ESP32-P4-EYE in its case**: two USB-C ports ("USB 2.0" and "DEBUG"), manual
focus lens, flash LED, tripod thread. There is **no WILEye Orca adapter** with it, so nothing
mates with the FREE-WILi header.

Tried (Sun ~2:30 AM): laptop -> FREE-WILi FW5171, Bottlenose Orca on the 20-pin header,
USB-C to USB-C from the Bottlenose to the camera. Result: the laptop sees only the FREE-WILi,
no camera and no drive; the FREE-WILi's I2C scan is empty; `wileye_take_picture` returns
`Failed`. Expected: every USB-C port in that chain is a USB *device* port, so there is no host
for the camera, and the FREE-WILi's camera link is UART on header pins, not USB.

Next: plug the camera's "USB 2.0" port straight into the laptop and see whether it shows up
as a webcam or as a USB drive.

## WILEye wiring (FREE-WILi 20-pin header)
The WILEye talks to the FREE-WILi over UART1 at 5 Mbps with hardware flow control.
| FREE-WILi header pin | Signal | ESP32-P4-EYE |
|---|---|---|
| 2 | 5V out | 5V |
| 9 | UART1 TX (out) | GPIO37 |
| 5 | UART1 RX (in) | GPIO38 |
| 7 | UART1 CTS (in) | GPIO34 |
| 11 | UART1 RTS (out) | GPIO51 |
| 19 or 20 | GND | GND |
| 4 to 6 | IO voltage = 3.3V | (jumper on the FREE-WILi itself) |

Source for the pin mapping: the FREE-WILi docs page "WILEYE Camera Orca - Hardware Hookup
Guide" (search-result summary; the page itself now returns 404), so treat it as unconfirmed
until a picture comes back. The WILEye Orca adapter board makes these connections for you.
