import base64, contextlib, importlib.util, io, json, os, pathlib, tempfile, unittest
spec = importlib.util.spec_from_file_location('checkpoint', pathlib.Path(__file__).with_name('checkpoint.py'))
hm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hm)

class Checkpoints(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        hm.ROOT = self.tmp.name
        hm.OWNER, hm.GROUP = os.getuid(), os.getgid()
    def tearDown(self):
        self.tmp.cleanup()
    def pack(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output): hm.pack()
        return output.getvalue()
    def restore(self, data):
        old = hm.sys.stdin
        hm.sys.stdin = io.TextIOWrapper(io.BytesIO(data.encode()))
        try: hm.restore()
        finally: hm.sys.stdin = old
    def test_roundtrip_git_and_source_excludes_packages(self):
        root = pathlib.Path(hm.ROOT)
        (root / '.git').mkdir(); (root / '.git/config').write_text('[core]\nrepositoryformatversion = 0\n')
        (root / 'main.py').write_text('print(42)\n'); (root / 'main.py').chmod(0o700)
        (root / 'node_modules').mkdir(); (root / 'node_modules/package.js').write_text('ephemeral')
        packed = self.pack()
        self.assertEqual({item['path'] for item in json.loads(packed)['files']}, {'.git/config', 'main.py'})
        with tempfile.TemporaryDirectory() as fresh:
            hm.ROOT = fresh; self.restore(packed)
            self.assertEqual(pathlib.Path(fresh, 'main.py').read_text(), 'print(42)\n')
            self.assertTrue(pathlib.Path(fresh, 'main.py').stat().st_mode & 0o100)
            self.assertEqual(pathlib.Path(fresh, '.git/config').read_text(), '[core]\nrepositoryformatversion = 0\n')
    def test_rejects_traversal_absolute_duplicate_and_oversized_data_before_write(self):
        for paths in [['../outside'], ['/tmp/escape'], ['a/../../b'], ['a//b'], ['a', 'a']]:
            data = json.dumps({'version': 1, 'files': [{'path': p, 'data': 'eA=='} for p in paths]})
            with self.assertRaises(ValueError): self.restore(data)
            self.assertEqual(list(pathlib.Path(hm.ROOT).iterdir()), [])
        with self.assertRaises(ValueError): self.restore('x' * (hm.MAX_WIRE + 1))
    def test_symlink_and_fifo_are_never_read(self):
        root = pathlib.Path(hm.ROOT)
        (root / 'leak').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError): self.pack()
        (root / 'leak').unlink(); os.mkfifo(root / 'pipe')
        with self.assertRaises(ValueError): self.pack()
    def test_size_and_file_count_are_bounded(self):
        root = pathlib.Path(hm.ROOT)
        (root / 'oversized').write_bytes(b'x' * (hm.MAX_DATA + 1))
        with self.assertRaises(ValueError): self.pack()
        (root / 'oversized').unlink()
        for n in range(hm.MAX_FILES + 1): (root / str(n)).touch()
        with self.assertRaises(ValueError): self.pack()

if __name__ == '__main__': unittest.main()
