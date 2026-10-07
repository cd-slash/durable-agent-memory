import importlib.util, pathlib, unittest
spec=importlib.util.spec_from_file_location('provision',pathlib.Path(__file__).resolve().parents[1]/'scripts/provision-tailnet.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class ProvisionTests(unittest.TestCase):
    def test_missing_credentials_no_effects(self):
        calls=[]
        with self.assertRaises(RuntimeError):p.provision({},'test','tag:hm-tailnet-gateway',lambda *a:calls.append(a))
        self.assertFalse(calls)
    def test_secret_only_uploaded_to_cloudflare(self):
        calls=[]
        def api(*args):
            calls.append(args)
            return {'id':'id1','key':'tskey-auth-fixture'} if args[0]=='POST' else {'success':True}
        result=p.provision({'TAILSCALE_API_KEY':'fake','CLOUDFLARE_API_TOKEN':'fake'},'test','tag:hm-tailnet-gateway',api)
        self.assertEqual(len(calls),2);self.assertNotIn('tskey-auth-fixture',str(result));self.assertEqual(calls[1][3]['type'],'secret_text');self.assertEqual(calls[0][3]['expirySeconds'],86400)
    def test_upload_failure_revokes_once(self):
        calls=[]
        def api(*args):
            calls.append(args)
            if args[0]=='POST':return {'id':'id1','key':'tskey-auth-fixture'}
            if args[0]=='PUT':raise RuntimeError('failed')
            return {}
        with self.assertRaisesRegex(RuntimeError,'revoked'):p.provision({'TAILSCALE_API_KEY':'fake','CLOUDFLARE_API_TOKEN':'fake'},'test','tag:hm-tailnet-gateway',api)
        self.assertEqual([a[0] for a in calls],['POST','PUT','DELETE'])
    def test_no_admin_tag(self):
        with self.assertRaises(RuntimeError):p.provision({'TAILSCALE_API_KEY':'fake','CLOUDFLARE_API_TOKEN':'fake'},'test','tag:admin-device',lambda *_:self.fail('effect'))
if __name__=='__main__':unittest.main()
