import sys
import os
import socket
import time

if not os.environ.get('DISPLAY') and not os.environ.get('WAYLAND_DISPLAY'):
    print("No display found. Run from a desktop session.")
    sys.exit(0)

try:
    import webview
except Exception as e:
    print(f"ERROR: Cannot load pywebview: {e}")
    print("Fix: sudo apt-get install python3-gi gir1.2-webkit2-4.1 gir1.2-gtk-3.0")
    sys.exit(1)

URL = "http://localhost:5000"
TIMEOUT = 60


def wait_for_backend(timeout=TIMEOUT):
    deadline = time.time() + timeout
    dots = 0
    while time.time() < deadline:
        try:
            with socket.create_connection(("localhost", 5000), timeout=1):
                print()
                return True
        except OSError:
            dots += 1
            print(f"\rWaiting for PLC Gateway service{'.' * (dots % 4)}   ", end="", flush=True)
            time.sleep(0.5)
    print()
    return False


def on_loaded(window):
    window.evaluate_js("document.body.classList.add('embedded')")


if not wait_for_backend():
    print("WARNING: Backend not ready after 60s — opening anyway")

window = webview.create_window(
    "PLC Gateway",
    URL,
    width=1280,
    height=720,
    fullscreen=True,
    resizable=False,
    min_size=(800, 480),
)
webview.start(on_loaded, window)
