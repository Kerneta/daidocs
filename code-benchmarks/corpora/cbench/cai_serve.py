"""Kerneta .cai HTTP query server (a lightweight alternative to an MCP server).

Exposes the query ops over HTTP so any tool can retrieve slices:
  GET /q?store=<store>&op=callers&arg=foo
  GET /health

Usage: python cai_serve.py <store> [port]
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cai_query

DEFAULT_STORE = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            return self._send(200, "ok")
        if u.path == "/q":
            store = q.get("store", [DEFAULT_STORE])[0]
            op = q.get("op", ["most_imported"])[0]
            args = q.get("arg", [])
            try:
                manifest, symbols, edges = cai_query.load(store)
                if op == "ask":
                    op, args = cai_query.parse_nl(manifest, symbols, " ".join(args))
                result = cai_query.run(store, op, args)
                return self._send(200, result)
            except Exception as e:
                return self._send(500, "error: {}".format(e))
        self._send(404, "not found")

    def _send(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))


def serve(store, port=8787):
    global DEFAULT_STORE
    DEFAULT_STORE = store
    srv = HTTPServer(("127.0.0.1", port), Handler)
    print("cai serve on http://127.0.0.1:{}  (store={})".format(port, store))
    srv.serve_forever()


if __name__ == "__main__":
    serve(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 8787)
