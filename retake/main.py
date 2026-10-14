"""Start Retake: the local engine plus its desktop window.

    python -m retake            open the app window
    python -m retake --browser  use the default browser instead
    python -m retake --port 8765 --no-window   engine only (for development)
"""

from __future__ import annotations

import argparse
import socket
import threading
import time
import webbrowser

import uvicorn

from . import app as api


def _free_port(preferred: int) -> int:
    for port in (preferred, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("No free port")


def _serve(port: int) -> uvicorn.Server:
    server = uvicorn.Server(uvicorn.Config(api.app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True, name="retake-api").start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    return server


def main() -> None:
    ap = argparse.ArgumentParser(prog="retake")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--browser", action="store_true")
    ap.add_argument("--no-window", action="store_true")
    args = ap.parse_args()

    port = _free_port(args.port)
    url = f"http://127.0.0.1:{port}/"

    if args.no_window:
        print(f"Retake engine on {url}")
        uvicorn.run(api.app, host="127.0.0.1", port=port, log_level="info")
        return

    server = _serve(port)
    if args.browser:
        webbrowser.open(url)
        print(f"Retake is open in your browser at {url}. Close this window to quit.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        return

    try:
        import webview
    except ImportError:
        webbrowser.open(url)
        while True:
            time.sleep(1)

    window = webview.create_window("Retake", url, width=1480, height=920, min_size=(1100, 700),
                                   background_color="#0b0d12", text_select=False)

    def pick_folder() -> str | None:
        result = window.create_file_dialog(webview.FileDialog.FOLDER)
        return result[0] if result else None

    api.window_api["pick_folder"] = pick_folder
    webview.start(private_mode=False)
    server.should_exit = True


if __name__ == "__main__":
    main()
