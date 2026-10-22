"""Serve the local app without dependencies; never expose it on the LAN."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import webbrowser


def main():
    options = argparse.ArgumentParser()
    options.add_argument("--no-browser", action="store_true")
    args = options.parse_args()
    assets = Path(__file__).resolve().parent.parent / "dist"
    if not (assets / "index.html").is_file():
        raise SystemExit("Missing dist/index.html. Extract the complete project folder first.")
    handler = partial(SimpleHTTPRequestHandler, directory=str(assets))
    server = None
    for port in range(4173, 4183):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), handler)
            break
        except OSError as error:
            if getattr(error, "winerror", None) != 10048 and error.errno != 98:
                raise
    if server is None:
        raise SystemExit("Ports 4173-4182 are busy. Close the previous app window and retry.")
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"MoveLite: {url}\nPress Ctrl+C or close this window to stop.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

