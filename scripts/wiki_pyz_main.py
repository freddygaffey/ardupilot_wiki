"""
Entry point embedded in <wiki>-wiki.pyz.

Serves the wiki straight out of the zip it is running from and opens a browser
at it. Nothing is extracted: pages are read from the archive on demand, so the
only disk cost is the file you downloaded.

    python3 rover-wiki.pyz

Serving over http rather than opening files directly matters for more than
tidiness. Sphinx's search fetches its index with fetch(), which browsers refuse
on file:// URLs, so a wiki opened straight from disk has no search at all. Over
localhost it works - and localhost is a secure origin, so the service worker and
the rest of the offline machinery work here too.
"""

import http.server
import mimetypes
import socket
import socketserver
import sys
import threading
import webbrowser
import zipfile

# Preferred port. A browser scopes storage, installed apps and service workers
# to an origin, and the port is part of that, so anything saved on a previous
# run belongs to whichever port that run used. We try this one first and only
# move on if it is taken - saying so when we do, because landing on a different
# port otherwise just looks like the saved pages have vanished.
PORT = 8790
PORT_ATTEMPTS = 12
PREFIX = "site/"

# One ZipFile per thread rather than one shared behind a mutex. ZipFile is not
# safe for concurrent reads, but serialising them means every image on a page
# queues behind the one before it, which is what made this feel slow. Opening
# per thread costs a central-directory read once per thread and then nothing.
_ARCHIVE_PATH = sys.path[0]
_local = threading.local()


def archive():
    zf = getattr(_local, "zf", None)
    if zf is None:
        zf = _local.zf = zipfile.ZipFile(_ARCHIVE_PATH)
    return zf


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass   # a request log per image is noise, not information

    def _resolve(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        if path.endswith("/"):
            path += "index.html"
        return PREFIX + path.lstrip("/")

    def do_GET(self):
        name = self._resolve(self.path)
        zf = archive()
        try:
            body = zf.read(name)
        except KeyError:
            # Directory URLs without a trailing slash are common in links.
            try:
                body = zf.read(name.rstrip("/") + "/index.html")
            except KeyError:
                self.send_error(404, "Not found in archive")
                return

        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def do_HEAD(self):
        self.do_GET()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        """
        Browsers close connections early all the time - they abandon images
        that scrolled out of view, and reload cancels whatever was in flight.
        With keep-alive that surfaces as BrokenPipe/ConnectionReset, which
        socketserver prints as a full traceback. It is normal traffic, not a
        fault, and printing a stack trace for it makes a working program look
        broken. Anything else still gets reported.
        """
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def bind():
    """Bind the preferred port, stepping to the next free one if it is taken."""
    for offset in range(PORT_ATTEMPTS):
        port = PORT + offset * 10
        try:
            return Server(("127.0.0.1", port), Handler), port, offset
        except OSError as exc:
            if exc.errno not in (48, 98):    # EADDRINUSE on macOS / Linux
                raise
    raise SystemExit(f"No free port found between {PORT} and "
                     f"{PORT + (PORT_ATTEMPTS - 1) * 10}.")


def main():
    httpd, port, offset = bind()

    if offset:
        print(f"Port {PORT} was busy, so this is running on {port}.\n"
              f"Browsers tie saved pages and installed apps to the exact "
              f"address, so anything saved on port {PORT} will not show up "
              f"here. Close whatever is using {PORT} to get it back.\n",
              file=sys.stderr)

    url = f"http://127.0.0.1:{port}/"
    print(f"ArduPilot wiki, offline.\n  {url}\n\nPress Ctrl+C to stop.")
    try:
        webbrowser.open(url)
    except Exception:
        pass    # headless machines are fine, the URL is printed above

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
