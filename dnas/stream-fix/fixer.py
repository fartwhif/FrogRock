#!/usr/bin/env python3
"""stream-fix: normalization shim between Shoutcast DNAS's relay client and FrogRock.

Shoutcast DNAS 2.6.1's relay client (Ultravox 2.1) emits two quirks that
break modern strict HTTP frontends (verified byte-for-byte against nginx
1.26.3 and Node.js/llhttp):

  1. A header NAME containing spaces: `Ultravox transport type:TCP`
     (header names must be a single token). FATAL for both nginx and Node:
     they reply 400. Every other quirk (no space after the header colon,
     e.g. `Host:value`) is TOLERATED by both and is left as-is.
  2. FrogRock (Node) answers HTTP/1.1 requests with `Transfer-Encoding:
     chunked`, which this vintage ICY client cannot parse. Downgrading the
     request to HTTP/1.0 makes Node answer close-delimited (no chunked) —
     classic ICY framing, body ends with connection close.

This filter rewrites exactly those two things and pipes all other bytes
(request and response, including the ICY metadata body) through verbatim.
"""
import os
import socket
import threading

LISTEN_PORT = int(os.environ.get('LISTEN_PORT', '8091'))
UPSTREAM_HOST = os.environ.get('UPSTREAM_HOST', 'frogrock')
UPSTREAM_PORT = int(os.environ.get('UPSTREAM_PORT', '8090'))


def normalize_request_head(head: bytes) -> bytes:
    lines = head.split(b'\r\n')
    if lines and lines[0].endswith(b'HTTP/1.1'):
        lines[0] = lines[0][: -len(b'HTTP/1.1')] + b'HTTP/1.0'
    out = [lines[0]]
    for line in lines[1:]:
        if line.startswith(b'Ultravox transport type:'):
            _, _, val = line.partition(b':')
            out.append(b'Ultravox-Transport-Type: ' + val.strip())
        else:
            out.append(line)
    return b'\r\n'.join(out)


def pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass


def close(sock: socket.socket) -> None:
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


def handle(client: socket.socket, addr) -> None:
    buf = b''
    while b'\r\n\r\n' not in buf:
        try:
            chunk = client.recv(65536)
        except OSError:
            chunk = b''
        if not chunk:
            close(client)
            return
        buf += chunk
        if len(buf) > 1 << 20:  # a request head is never this big
            close(client)
            return
    head, _, rest = buf.partition(b'\r\n\r\n')
    parts = head.split(b' ', 2)
    path = parts[1].decode('latin1') if len(parts) > 1 else '?'
    print(f'stream-fix: {addr[0]} {path}', flush=True)
    try:
        upstream = socket.create_connection((UPSTREAM_HOST, UPSTREAM_PORT), timeout=10)
    except OSError as err:
        print(f'stream-fix: upstream unreachable: {err}', flush=True)
        client.sendall(b'HTTP/1.0 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        close(client)
        return
    try:
        upstream.sendall(normalize_request_head(head) + b'\r\n\r\n' + rest)
        pipe(upstream, client)
    finally:
        close(client)
        close(upstream)


def main() -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('0.0.0.0', LISTEN_PORT))
    srv.listen(16)
    print(f'stream-fix: :{LISTEN_PORT} -> {UPSTREAM_HOST}:{UPSTREAM_PORT}', flush=True)
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle, args=(conn, addr), daemon=True).start()


if __name__ == '__main__':
    main()
