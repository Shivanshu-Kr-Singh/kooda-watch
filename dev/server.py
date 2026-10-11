"""Run Kooda Watch on your own machine, no AWS needed.

    python3 dev/server.py              # http://localhost:8000
    OFFICER_KEY=secret123456 python3 dev/server.py

Same API as the Lambda (backend/core.py is shared). Reports are kept in
dev/data/. Phones need HTTPS to share GPS; localhost counts as secure, so test
the citizen page on the same computer, or deploy to AWS (CloudFront gives HTTPS).
"""
import json
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import core  # noqa: E402

FRONTEND = os.path.join(ROOT, "frontend")
DATA_DIR = os.path.join(ROOT, "dev", "data")
IMAGE_DIR = os.path.join(DATA_DIR, "images")
REPORTS_FILE = os.path.join(DATA_DIR, "reports.json")
OFFICER_KEY = os.environ.get("OFFICER_KEY", "local-officer-key")
MAX_BODY = 4 * 1024 * 1024


class FileStore:
    def __init__(self):
        self._lock = threading.Lock()
        os.makedirs(IMAGE_DIR, exist_ok=True)

    def _read(self):
        try:
            with open(REPORTS_FILE, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except FileNotFoundError:
            return []

    def put_report(self, item):
        with self._lock:
            items = self._read()
            items.append(item)
            tmp = REPORTS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(items, fh)
            os.replace(tmp, REPORTS_FILE)

    def put_image(self, key, data):
        with open(os.path.join(IMAGE_DIR, os.path.basename(key)), "wb") as fh:
            fh.write(data)

    def list_reports(self):
        with self._lock:
            return self._read()

    def image_url(self, key):
        return "/dev-images/" + os.path.basename(key)


STORE = FileStore()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FRONTEND, **kwargs)

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/hotspots":
            if not core.check_officer_key(self.headers.get("x-officer-key"), OFFICER_KEY):
                return self._send_json(401, {"error": "Officer key required"})
            return self._send_json(200, core.get_hotspots(STORE))
        if path.startswith("/dev-images/"):
            name = os.path.basename(path)
            file_path = os.path.join(IMAGE_DIR, name)
            if not name or not os.path.isfile(file_path):
                return self._send_json(404, {"error": "Not found"})
            with open(file_path, "rb") as fh:
                data = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path.startswith("/api/"):
            return self._send_json(404, {"error": "Not found"})
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/reports":
            return self._send_json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                raise core.ApiError(413, "Request is too large")
            try:
                body = json.loads(self.rfile.read(length))
            except ValueError:
                raise core.ApiError(400, "Body must be JSON")
            return self._send_json(201, core.create_report(body, STORE))
        except core.ApiError as err:
            return self._send_json(err.status, {"error": err.message})

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("Kooda Watch dev server")
    print("  citizen page : http://localhost:%d/" % port)
    print("  officer page : http://localhost:%d/officer.html" % port)
    print("  officer key  : %s" % OFFICER_KEY)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
