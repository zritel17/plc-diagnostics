import sys
import os
import socket
import time
import argparse

parser = argparse.ArgumentParser(description="PLC Gateway native window")
parser.add_argument("--url",           default="http://localhost:5000", help="Backend URL")
parser.add_argument("--no-fullscreen", action="store_true",             help="Windowed mode (for dev)")
parser.add_argument("--width",         type=int, default=1280)
parser.add_argument("--height",        type=int, default=720)
args = parser.parse_args()

if not os.environ.get('DISPLAY') and not os.environ.get('WAYLAND_DISPLAY') and sys.platform == "linux":
    print("No display found. Run from a desktop session.")
    sys.exit(0)

try:
    import webview
except Exception as e:
    print(f"ERROR: Cannot load pywebview: {e}")
    if sys.platform == "linux":
        print("Fix: sudo apt-get install python3-gi gir1.2-webkit2-4.1 gir1.2-gtk-3.0")
    else:
        print("Fix: pip install pywebview")
    sys.exit(1)

TIMEOUT = 60


def wait_for_backend(url: str, timeout: int = TIMEOUT):
    from urllib.parse import urlparse
    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    deadline = time.time() + timeout
    dots = 0
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
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


if not wait_for_backend(args.url):
    print("WARNING: Backend not ready after 60s — opening anyway")

fullscreen = not args.no_fullscreen and sys.platform != "darwin"

window = webview.create_window(
    "PLC Gateway",
    args.url,
    width=args.width,
    height=args.height,
    fullscreen=fullscreen,
    resizable=args.no_fullscreen or sys.platform == "darwin",
    min_size=(800, 480),
)
webview.start(on_loaded, window)
