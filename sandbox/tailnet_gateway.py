#!/usr/bin/env python3
"""Trusted, bounded tailnet gateway. Never executes agent-supplied code or commands."""
import base64, hmac, http.client, ipaddress, json, os, signal, socket, ssl, struct, subprocess, threading, time, selectors
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
READY = threading.Event()
TARGETS = {}
TOKEN = ''
MAX_BODY = 8192

def allowed_host(host):
    try: return ipaddress.ip_address(host) in ipaddress.ip_network('100.64.0.0/10')
    except ValueError:
        import re
        return len(host) <= 253 and bool(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.ts\.net', host))

def validate_operation(op, targets):
    if not isinstance(op, dict) or op.get('kind') not in ('http', 'tcp', 'ssh'): raise ValueError('Invalid operation')
    target = targets.get(op.get('target'))
    if not target or not allowed_host(target['host']) or type(op.get('port')) is not int or op['port'] not in target['ports']: raise ValueError('Destination denied')
    if op['kind'] == 'ssh':
        if op['port'] != 22 or op.get('user') not in target.get('sshUsers', []) or 'path' in op or 'tls' in op: raise ValueError('SSH denied')
    elif op['kind'] == 'http':
        if 'user' in op: raise ValueError('Unexpected SSH user')
        import re
        path = op.get('path')
        if not isinstance(path, str) or len(path) > 1024 or not path.startswith('/') or path.startswith('//') or re.search(r'[\x00-\x20\x7f\\#]|%(?:0a|0d|00)', path, re.I) or ('tls' in op and type(op['tls']) is not bool): raise ValueError('Invalid path')
    elif 'path' in op or 'tls' in op or 'user' in op: raise ValueError('Invalid TCP arguments')
    return target

def read_exact(sock, n):
    data = b''
    while len(data) < n:
        part = sock.recv(n - len(data))
        if not part: raise ValueError('Proxy closed')
        data += part
    return data

def socks_connect(host, port, proxy=('127.0.0.1', 1055)):
    sock = socket.create_connection(proxy, timeout=5)
    try:
        sock.settimeout(5); sock.sendall(b'\x05\x01\x00')
        if read_exact(sock, 2) != b'\x05\x00': raise ValueError('Proxy auth denied')
        name = host.encode('ascii')
        if not name or len(name) > 253: raise ValueError('Invalid host')
        sock.sendall(b'\x05\x01\x00\x03' + bytes([len(name)]) + name + struct.pack('!H', port))
        reply = read_exact(sock, 4)
        if reply[:3] != b'\x05\x00\x00': raise ValueError('Proxy connection denied')
        size = {1: 4, 4: 16}.get(reply[3])
        if reply[3] == 3: size = read_exact(sock, 1)[0]
        if size is None: raise ValueError('Invalid proxy reply')
        read_exact(sock, size + 2)
        return sock
    except Exception: sock.close(); raise

def bounded_command(command):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True, env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/run'})
    output = b''; deadline = time.monotonic() + 10
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining): raise TimeoutError('SSH deadline')
                chunk = os.read(process.stdout.fileno(), 513 - len(output))
                if not chunk: break
                output += chunk
                if len(output) > 512: raise ValueError('SSH output too large')
        if process.wait(timeout=max(0.01, deadline - time.monotonic())): raise ValueError('SSH denied')
        if not output.startswith(b'TAILNET_SSH_OK\n'): raise ValueError('SSH marker missing')
        return output
    finally:
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        process.stdout.close()
        try: process.wait(timeout=1)
        except subprocess.TimeoutExpired: pass

def execute(op, targets, connector=socks_connect):
    target = validate_operation(op, targets)
    if op['kind'] == 'ssh':
        # Fixed read-only command; tailscale wrapper checks coordination-server host keys.
        command = ['/usr/local/bin/tailscale', '--socket=/run/hm-tailscale.sock', 'ssh', op['user'] + '@' + target['host'], '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'RequestTTY=no', 'printf "TAILNET_SSH_OK\\n"; id -un']
        output = bounded_command(command)
        return {'ok': True, 'banner': output.decode('utf-8', errors='replace')}
    sock = connector(target['host'], op['port'])
    try:
        if op['kind'] == 'tcp':
            sock.settimeout(2)
            try: banner = sock.recv(512).decode('utf-8', errors='replace')
            except socket.timeout: banner = ''
            return {'ok': True, 'banner': banner}
        connection = http.client.HTTPConnection(target['host'], op['port'], timeout=10)
        if op.get('tls'):
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=target['host'])
        connection.sock = sock
        connection.request('GET', op['path'], headers={'User-Agent': 'durable-agent-memory-tailnet', 'Accept-Encoding': 'identity', 'Connection': 'close'})
        response = connection.getresponse()
        if 300 <= response.status < 400: raise ValueError('Redirect denied')
        body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY: raise ValueError('Response too large')
        # Base64 keeps worst-case UTF-8 replacement/escaping within Worker result caps.
        return {'ok': True, 'status': response.status, 'bodyBase64': base64.b64encode(body).decode()}
    finally: sock.close()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def response(self, status, value):
        data = json.dumps(value, separators=(',', ':')).encode()
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path != '/health': return self.response(404, {'ok': False})
        return self.response(200, {'ready': READY.is_set()})
    def do_POST(self):
        self.connection.settimeout(3)
        try:
            if self.path != '/run' or not TOKEN or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN): return self.response(403, {'ok': False})
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096: return self.response(413, {'ok': False})
            op = json.loads(self.rfile.read(length))
            validate_operation(op, TARGETS)
            if not READY.wait(15): return self.response(503, {'ok': False, 'error': 'Tailnet enrollment unavailable'})
            return self.response(200, execute(op, TARGETS))
        except Exception: return self.response(503, {'ok': False, 'error': 'Tailnet request rejected, timed out or exceeded limit'})

class Server(ThreadingHTTPServer):
    daemon_threads = True
    semaphore = threading.BoundedSemaphore(2)
    def process_request(self, request, address):
        if not self.semaphore.acquire(False): request.close(); return
        try: super().process_request(request, address)
        except Exception: self.semaphore.release(); raise
    def process_request_thread(self, request, address):
        try: super().process_request_thread(request, address)
        finally: self.semaphore.release()

def main():
    global TOKEN, TARGETS
    signal.signal(signal.SIGALRM, lambda *_: os._exit(0)); signal.alarm(75)
    TOKEN = os.environ.pop('HM_GATEWAY_TOKEN', '')
    key = os.environ.pop('TAILSCALE_AUTH_KEY', '')
    targets = json.loads(os.environ.pop('HM_TAILNET_TARGETS', '[]'))
    if not TOKEN or not key.startswith('tskey-auth-') or not targets: return 1
    TARGETS = {t['name']: t for t in targets}
    key_path = '/run/hm-tailnet-auth'
    fd = os.open(key_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f: f.write(key)
    key = ''
    subprocess.Popen(['/usr/local/bin/tailscaled', '--tun=userspace-networking', '--socks5-server=127.0.0.1:1055', '--state=mem:', '--socket=/run/hm-tailscale.sock'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={'PATH': '/usr/local/bin:/usr/bin:/bin'})
    def enroll():
        try:
            deadline = time.monotonic() + 5
            while not os.path.exists('/run/hm-tailscale.sock'):
                if time.monotonic() >= deadline: raise TimeoutError('Daemon unavailable')
                time.sleep(0.1)
            # File transport avoids keys in argv, output, shell interpolation or child env.
            result = subprocess.run(['/usr/local/bin/tailscale', '--socket=/run/hm-tailscale.sock', 'up', '--auth-key=file:' + key_path, '--hostname=hm-tailnet-gateway', '--accept-dns=false', '--accept-routes=false'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, env={'PATH': '/usr/local/bin:/usr/bin:/bin'})
            if result.returncode == 0: READY.set()
        except Exception: pass
        finally:
            try: os.unlink(key_path)
            except FileNotFoundError: pass
    threading.Thread(target=enroll, daemon=True).start()
    Server(('0.0.0.0', 8080), Handler).serve_forever()
    return 0

if __name__ == '__main__':
    try: raise SystemExit(main())
    except Exception: raise SystemExit(1)
