"""Static server for the frozen verification bundle, plus a capture endpoint.

Same origin as the page, so `fetch('/shot?name=x', {method:'POST'})` from the
running game needs no CORS and the saved PNG is exactly what the renderer
produced. Verification tooling only; nothing in the product talks to this.
"""
import base64
import http.server
import os
import sys
import urllib.parse

ROOT = sys.argv[1]
SHOTS = sys.argv[2]
PORT = int(sys.argv[3])
os.makedirs(SHOTS, exist_ok=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != '/shot':
            self.send_error(404)
            return
        name = urllib.parse.parse_qs(parsed.query).get('name', ['shot'])[0]
        name = ''.join(c for c in name if c.isalnum() or c in '-_')
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8')
        if ',' in body:
            body = body.split(',', 1)[1]
        path = os.path.join(SHOTS, name + '.png')
        with open(path, 'wb') as fh:
            fh.write(base64.b64decode(body))
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(str(os.path.getsize(path)).encode())


http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
