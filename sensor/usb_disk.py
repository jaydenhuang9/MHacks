"""Switch the ESP32-P4-EYE between "camera" and "USB disk" from the laptop, without replugging.

The camera's stock firmware exposes its SD card as a USB drive on the "USB 2.0" port, and it
refuses to take photos while the laptop has that drive loaded. Ejecting the drive (the same
thing as "Eject" in Explorer) gives the camera back; loading it again brings the photos back.

    python sensor/usb_disk.py status
    python sensor/usb_disk.py eject     # camera can shoot
    python sensor/usb_disk.py load      # laptop can read the photos
"""

from __future__ import annotations

import ctypes
import pathlib
import sys
import time
from ctypes import wintypes

DRIVE = "D:"
PHOTO_DIR = pathlib.Path(DRIVE + "\\") / "esp32_p4_pic_save"

GENERIC_READ = 0x80000000
FILE_SHARE_READ_WRITE = 0x00000001 | 0x00000002
OPEN_EXISTING = 3
IOCTL_STORAGE_EJECT_MEDIA = 0x002D4808
IOCTL_STORAGE_LOAD_MEDIA = 0x002D480C
FSCTL_LOCK_VOLUME = 0x00090018
FSCTL_DISMOUNT_VOLUME = 0x00090020

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.CreateFileW.restype = wintypes.HANDLE
kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                 wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel32.DeviceIoControl.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD,
                                     wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
INVALID_HANDLE = wintypes.HANDLE(-1).value


def _ioctl(*codes: int, drive: str = DRIVE) -> None:
    handle = kernel32.CreateFileW(f"\\\\.\\{drive}", GENERIC_READ, FILE_SHARE_READ_WRITE, None, OPEN_EXISTING, 0, None)
    if handle == INVALID_HANDLE:
        raise OSError(ctypes.get_last_error(), f"cannot open {drive} (is the camera on the USB 2.0 port?)")
    try:
        returned = wintypes.DWORD(0)
        for code in codes:
            if not kernel32.DeviceIoControl(handle, code, None, 0, None, 0, ctypes.byref(returned), None):
                raise OSError(ctypes.get_last_error(), f"DeviceIoControl 0x{code:08X} failed on {drive}")
    finally:
        kernel32.CloseHandle(handle)


def is_loaded() -> bool:
    """True when the laptop can read the camera's card right now."""
    try:
        return PHOTO_DIR.is_dir()
    except OSError:
        return False


def eject() -> None:
    """Give the card back to the camera so it can take photos."""
    if is_loaded():
        try:
            _ioctl(FSCTL_LOCK_VOLUME, FSCTL_DISMOUNT_VOLUME, IOCTL_STORAGE_EJECT_MEDIA)
        except OSError:
            _ioctl(IOCTL_STORAGE_EJECT_MEDIA)  # volume busy: eject without the lock


def load(timeout: float = 8.0) -> bool:
    """Ask the camera for its card back. Returns True once the photo folder is readable."""
    try:
        _ioctl(IOCTL_STORAGE_LOAD_MEDIA)
    except OSError as ex:
        print(f"load request failed: {ex}")
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if is_loaded():
            return True
        time.sleep(0.25)
    return False


def photos() -> list[pathlib.Path]:
    return sorted((p for p in PHOTO_DIR.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime)


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    if action == "eject":
        eject()
    elif action == "load":
        print("loaded" if load() else "NOT loaded (the camera did not give the card back)")
    print("state:", "USB disk (laptop can read photos)" if is_loaded() else "camera (laptop cannot see the card)")
    if is_loaded():
        for photo in photos()[-10:]:
            print(f"  {photo.name}  {photo.stat().st_size} bytes")
