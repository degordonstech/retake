"""Start Retake: the local engine plus its desktop window.

    python -m retake            open the app window
    python -m retake --browser  use the default browser instead
    python -m retake --port 8765 --no-window   engine only (for development)

The desktop shortcut runs this with pythonw, which has no console, so
everything goes to %APPDATA%/Retake/retake.log.
"""

from __future__ import annotations

import argparse
import logging
import socket
import subprocess
import sys
import threading
import time
import webbrowser

import httpx
import uvicorn

from . import app as api
from .config import APP_DIR

log = logging.getLogger("retake")
WEBVIEW_DATA = APP_DIR / "webview"
# A window that hasn't asked the engine for anything by now came up blank.
LOAD_TIMEOUT = 25


def _setup_logging() -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(APP_DIR / "retake.log", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler])
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if sys.stdout is None or sys.stderr is None:  # pythonw
        stream = open(APP_DIR / "retake.log", "a", encoding="utf-8", buffering=1)  # noqa: SIM115
        sys.stdout = sys.stdout or stream
        sys.stderr = sys.stderr or stream


def _free_port(preferred: int) -> int:
    for port in (preferred, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("No free port")


def _focus_running(port: int) -> bool:
    """If Retake is already open, bring its window forward instead of starting a second one."""
    try:
        if httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=1.5).json().get("ok"):
            return bool(httpx.post(f"http://127.0.0.1:{port}/api/focus", timeout=3).json().get("ok"))
    except (httpx.HTTPError, ValueError):
        pass
    return False


def _clear_stale_webview() -> None:
    """A window that crashed or was killed can leave WebView2 running on our data
    folder, and every later window then opens blank ("the requested resource is in
    use"). Nothing else uses that folder, so anything still on it is left over."""
    if sys.platform != "win32":
        return
    script = ("Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | "
              f"Where-Object {{ $_.CommandLine -like '*{WEBVIEW_DATA}*' }} | "
              "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }")
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                             capture_output=True, text=True, timeout=20,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.split()
        if out:
            log.info("Cleared %d leftover WebView2 processes", len(out))
            time.sleep(0.5)
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("Couldn't check for leftover WebView2: %s", e)


def _serve(port: int) -> uvicorn.Server:
    server = uvicorn.Server(uvicorn.Config(api.app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True, name="retake-api").start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    return server


def _browser_forever(url: str) -> None:
    webbrowser.open(url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


def main() -> None:
    ap = argparse.ArgumentParser(prog="retake")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--browser", action="store_true")
    ap.add_argument("--no-window", action="store_true")
    args = ap.parse_args()
    _setup_logging()

    if args.no_window:
        port = _free_port(args.port)
        print(f"Retake engine on http://127.0.0.1:{port}/")
        uvicorn.run(api.app, host="127.0.0.1", port=port, log_level="info")
        return

    if _focus_running(args.port):
        log.info("Already open, brought it to the front")
        return

    port = _free_port(args.port)
    url = f"http://127.0.0.1:{port}/"
    server = _serve(port)
    log.info("Engine on %s", url)

    if args.browser:
        print(f"Retake is open in your browser at {url}. Close this window to quit.")
        _browser_forever(url)
        return

    try:
        import webview
    except ImportError:
        log.warning("pywebview isn't installed, using the browser")
        _browser_forever(url)
        return

    _clear_stale_webview()
    window = webview.create_window("Retake", url, width=1480, height=920, min_size=(1100, 700),
                                   background_color="#0b0d12", text_select=False)

    def pick_folder() -> str | None:
        result = window.create_file_dialog(webview.FileDialog.FOLDER)
        return result[0] if result else None

    def focus() -> None:
        window.restore()
        window.show()
        window.on_top = True
        window.on_top = False

    api.window_api["pick_folder"] = pick_folder
    api.window_api["focus"] = focus
    opened = time.time()
    fell_back = threading.Event()

    def watchdog() -> None:
        time.sleep(LOAD_TIMEOUT)
        if api.window_api["seen"] < opened:
            log.error("The window didn't load in %d s, opening Retake in the browser instead", LOAD_TIMEOUT)
            fell_back.set()
            api.window_api["pick_folder"] = api.window_api["focus"] = None
            webbrowser.open(url)
            window.destroy()

    threading.Thread(target=watchdog, daemon=True, name="retake-watchdog").start()
    try:
        webview.start(private_mode=False, storage_path=str(WEBVIEW_DATA))
    except Exception:  # noqa: BLE001 - any window failure still leaves the app usable
        log.exception("The window failed to start, using the browser")
        fell_back.set()
        webbrowser.open(url)
    if fell_back.is_set():
        _browser_forever(url)
    server.should_exit = True


if __name__ == "__main__":
    main()
