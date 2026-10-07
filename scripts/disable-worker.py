#!/usr/bin/env python3
"""Out-of-band public-endpoint shutoff. No secrets are written or printed. No automatic retries."""
import json, os, shlex, sys, urllib.request, urllib.error
from pathlib import Path
ACCOUNT = 'efceafa29432e7f5d5fc86703f78d81b'
WORKER = 'durable-agent-memory'

def credentials():
    values = dict(os.environ)
    path = Path(os.environ.get('BILLING_CREDENTIAL_FILE', '/home/coder/.env'))
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip().removeprefix('export ')
            if not line or line.startswith('#') or '=' not in line: continue
            key, value = line.split('=', 1)
            parts = shlex.split(value, comments=True)
            values.setdefault(key.strip(), parts[0] if parts else '')
    token = values.get('CLOUDFLARE_API_TOKEN') or values.get('CLOUDFLARE_API_KEY')
    if not token: raise RuntimeError('No configured API token; use the authenticated Cloudflare dashboard to disable the Worker route')
    return token

def api(token, path, body=None):
    request = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, data=json.dumps(body).encode() if body is not None else None, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=15) as response: result = json.load(response)
    except urllib.error.HTTPError as error: raise RuntimeError('Cloudflare admin API returned HTTP ' + str(error.code)) from None
    if not result.get('success'): raise RuntimeError('Cloudflare admin API rejected operation')
    return result['result']

def main():
    if any(arg not in ['--dry-run', '--confirm-disable'] for arg in sys.argv[1:]): raise RuntimeError('Use --dry-run or --confirm-disable')
    dry = '--dry-run' in sys.argv
    if not dry and '--confirm-disable' not in sys.argv: raise RuntimeError('Explicit --confirm-disable required (reversible service interruption)')
    token = credentials()
    path = f'/accounts/{ACCOUNT}/workers/scripts/{WORKER}/subdomain'
    before = api(token, path)
    if dry:
        print(json.dumps({'worker': WORKER, 'workers_dev_enabled': before.get('enabled'), 'preview_urls_enabled': before.get('previews_enabled'), 'would_disable': True, 'scope': 'workers.dev and preview URLs only; custom routes and alarms require separate attention'}))
        return
    api(token, path, {'enabled': False, 'previews_enabled': False})
    after = api(token, path)
    if after.get('enabled') or after.get('previews_enabled'): raise RuntimeError('Endpoint disable verification failed')
    print(json.dumps({'worker': WORKER, 'workers_dev_enabled': False, 'preview_urls_enabled': False, 'warning': 'Existing tasks, DO storage and any custom routes may still incur costs. Latch the app stop when reachable. Do not redeploy/reopen routes without owner approval.'}))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Endpoint control failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
