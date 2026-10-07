#!/usr/bin/env python3
"""Bounded, no-follow workspace checkpoint. Pack is untrusted under root-capable runtimes; restore must use a fresh image."""
import base64, json, os, stat, sys
ROOT = '/workspace'
OWNER, GROUP = 1000, 1000
MAX_DATA = 2 * 1048576
MAX_WIRE = 2800000
MAX_FILES = 512
SKIP = {'node_modules', '.cache', '.venv', '__pycache__'}

def valid_path(path):
    return isinstance(path, str) and 0 < len(path.encode()) <= 512 and not path.startswith('/') and all(p not in ('', '.', '..') for p in path.split('/')) and '\x00' not in path

def pack():
    files, size = [], 0
    for folder, dirs, names, fd in os.fwalk(ROOT, follow_symlinks=False):
        for name in list(dirs):
            if name in SKIP:
                dirs.remove(name)
            elif stat.S_ISLNK(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode):
                raise ValueError('Checkpoint does not retain symlinks')
        for name in sorted(names):
            path = os.path.relpath(os.path.join(folder, name), ROOT)
            if not valid_path(path):
                raise ValueError('Invalid checkpoint path')
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('Checkpoint only retains regular files')
            if info.st_size + size > MAX_DATA or len(files) >= MAX_FILES:
                raise ValueError('Checkpoint exceeds file/byte ceiling; prior checkpoint retained')
            filefd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            with os.fdopen(filefd, 'rb') as f:
                opened = os.fstat(f.fileno())
                if not stat.S_ISREG(opened.st_mode):
                    raise ValueError('Checkpoint file changed type')
                data = f.read(MAX_DATA - size + 1)
            size += len(data)
            if size > MAX_DATA:
                raise ValueError('Checkpoint exceeds byte ceiling')
            files.append({'path': path, 'data': base64.b64encode(data).decode(), 'executable': bool(info.st_mode & 0o111)})
    payload = json.dumps({'version': 1, 'files': files}, separators=(',', ':'))
    if len(payload.encode()) > MAX_WIRE:
        raise ValueError('Checkpoint wire ceiling exceeded')
    sys.stdout.write(payload)

def restore():
    raw = sys.stdin.buffer.read(MAX_WIRE + 1)
    if len(raw) > MAX_WIRE:
        raise ValueError('Checkpoint input ceiling exceeded')
    payload = json.loads(raw)
    if payload.get('version') != 1 or not isinstance(payload.get('files'), list) or len(payload['files']) > MAX_FILES:
        raise ValueError('Invalid checkpoint format')
    prepared, seen, size = [], set(), 0
    for item in payload['files']:
        path = item['path']
        if not valid_path(path) or path in seen:
            raise ValueError('Invalid/duplicate checkpoint path')
        seen.add(path)
        data = base64.b64decode(item['data'], validate=True)
        size += len(data)
        if size > MAX_DATA:
            raise ValueError('Checkpoint data ceiling exceeded')
        prepared.append((path, data, bool(item.get('executable'))))
    # Fresh container, before any user process: validation finishes before file effects.
    for path, data, executable in prepared:
        target = os.path.join(ROOT, path)
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if executable else 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
    # Fixed local UID, no host or provider credentials.
    for folder, dirs, names in os.walk(ROOT):
        os.chown(folder, OWNER, GROUP)
        for name in names:
            os.chown(os.path.join(folder, name), OWNER, GROUP, follow_symlinks=False)

if __name__ == '__main__':
    try:
        {'pack': pack, 'restore': restore}[sys.argv[1]]()
    except Exception:
        # Never include file content, paths or credentials in diagnostics.
        sys.stderr.write('Workspace checkpoint rejected (format, symlink, file count or size limit)\n')
        sys.exit(1)
