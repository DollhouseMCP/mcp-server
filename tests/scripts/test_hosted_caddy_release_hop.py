"""The acceptance and denial probes behind a hop that drops "Content-Length: 0" from a GET, as a CDN does.

Loopback only, no Docker. The probes are the tooling's own, run with the system curl. The fence here is a stand-in
that applies the verification matcher's rule for a request without a body. The rendered matcher itself is exercised
on the real proxy, with the same kind of hop in front, by scripts/ci/caddy-image-runtime.mjs.
"""
import os
from pathlib import Path
import socket
import socketserver
import sys
import threading
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_release_action as release

TOKEN = 'a' * 32
END = b'\r\n\r\n'
ROUTES = {'/healthz': 200, '/readyz': 200, '/mcp': 401}
REFUSED = ('authorization', 'cookie', 'upgrade', 'transfer-encoding')


def head(connection):
    """One request head: its request line and its header lines."""
    data = b''
    while END not in data:
        chunk = connection.recv(65536)
        if not chunk:
            break
        data += chunk
    return data.split(END)[0].decode('latin-1').split('\r\n')


class Loopback(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, handler):
        super().__init__(('127.0.0.1', 0), handler)
        self.origin = 'http://127.0.0.1:%d' % self.server_address[1]
        threading.Thread(target=self.serve_forever, daemon=True).start()

    def stop(self):
        self.shutdown()
        self.server_close()


def fence(require_length):
    """The verification fence. `require_length` is the former rule: a GET passes only with "Content-Length: 0"."""
    seen = []

    class Fence(socketserver.BaseRequestHandler):
        def handle(self):
            lines = head(self.request)
            method, path, _ = lines[0].split(' ')
            headers = {name.strip().lower(): value.strip() for name, value in (line.split(':', 1) for line in lines[1:])}
            seen.append((method, path, headers))
            length = headers.get('content-length')
            passes = (method == 'GET' and path in ROUTES and not any(name in headers for name in REFUSED)
                      and (length == '0' if require_length else length in (None, '0')))
            status = ROUTES[path] if passes else 503
            self.request.sendall(('HTTP/1.1 %d Fixture\r\nX-Dollhouse-Verification: %s\r\nContent-Length: 0\r\n'
                                  'Connection: close\r\n\r\n' % (status, TOKEN)).encode('ascii'))

    server = Loopback(Fence)
    server.seen = seen
    return server


def hop(target):
    """It passes each request on to the fence, and drops "Content-Length: 0" from a GET on the way."""
    dropped = []

    class Hop(socketserver.BaseRequestHandler):
        def handle(self):
            lines = head(self.request)
            kept = [line for line in lines
                    if not (lines[0].startswith('GET ') and line.replace(' ', '').lower() == 'content-length:0')]
            dropped.append(len(lines) - len(kept))
            with socket.create_connection(target.server_address) as onward:
                onward.sendall('\r\n'.join(kept).encode('latin-1') + END)
                while True:
                    chunk = onward.recv(65536)
                    if not chunk:
                        break
                    self.request.sendall(chunk)

    server = Loopback(Hop)
    server.dropped = dropped
    return server


@unittest.skipUnless(os.access(release.CURL, os.X_OK), 'the system curl is required')
class ProbesBehindHopTests(unittest.TestCase):
    def serve(self, require_length=False):
        behind = fence(require_length)
        front = hop(behind)
        self.addCleanup(behind.stop)
        self.addCleanup(front.stop)
        return behind, front

    def former_probe(self, origin):
        """The acceptance request as it was sent before: a GET that carries "Content-Length: 0"."""
        output = release.bounded_input([release.CURL, '--disable', '--noproxy', '*', '--http1.1', '--header', 'Content-Length: 0',
                                        '--silent', '--show-error', '--max-time', '5', '--include', '--write-out',
                                        '\n%{http_code}', origin + '/healthz'])
        return release.public_response(output)[1]

    def test_acceptance_passes_behind_the_hop(self):
        behind, front = self.serve()
        for path, status in ROUTES.items():
            release.public_probe(front.origin, path, str(status).encode('ascii'), False, 5, TOKEN)
        self.assertEqual([(method, path) for method, path, _ in behind.seen], [('GET', path) for path in ROUTES])
        # The probe carries nothing a hop drops: the request is the same with the hop and without it.
        self.assertEqual(front.dropped, [0, 0, 0])
        self.assertFalse(any('content-length' in headers for _, _, headers in behind.seen))

    def test_former_rule_and_probe_cannot_pass_behind_the_hop(self):
        behind, front = self.serve(require_length=True)
        self.assertEqual(self.former_probe(behind.origin), b'200')
        # The same request through the hop: the header is gone when it arrives, and the fence answers 503.
        self.assertEqual(self.former_probe(front.origin), b'503')
        self.assertEqual(front.dropped, [1])
        with self.assertRaisesRegex(ValueError, 'required status'):
            release.public_probe(front.origin, '/healthz', b'200', False, 0, TOKEN)

    def test_former_probe_passes_the_current_rule_behind_the_hop(self):
        behind, front = self.serve()
        self.assertEqual(self.former_probe(front.origin), b'200')
        self.assertEqual(front.dropped, [1])
        self.assertNotIn('content-length', behind.seen[0][2])

    def test_denials_hold_behind_the_hop(self):
        behind, front = self.serve()
        release.confirm_denials(front.origin, TOKEN)
        (post, post_path, post_headers), (get, get_path, get_headers) = behind.seen
        self.assertEqual((post, post_path, post_headers.get('content-length')), ('POST', '/mcp', '0'))
        self.assertEqual((get, get_path), ('GET', '/healthz'))
        self.assertIn('authorization', get_headers)
        self.assertNotIn('content-length', get_headers)
        self.assertEqual(front.dropped, [0, 0])


if __name__ == '__main__':
    unittest.main()
