import base64, io, json, socket, threading, unittest
from unittest.mock import patch
import tailnet_gateway as g
T={'test':{'name':'test','host':'test.example.ts.net','ports':[22,80],'sshUsers':['root']}}
class GatewayTests(unittest.TestCase):
    def test_validation(self):
        for host in ['127.0.0.1','100.128.0.1','example.com','-bad.example.ts.net']:
            self.assertFalse(g.allowed_host(host))
        for path in ['//evil','/bad\r\nX: y','/%0d','/space here','/a#b']:
            with self.assertRaises(ValueError):g.validate_operation({'target':'test','kind':'http','port':80,'path':path},T)
        with self.assertRaises(ValueError):g.validate_operation({'target':'test','kind':'ssh','port':22,'user':'ubuntu'},T)
    def test_socks_protocol(self):
        listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1);listener.settimeout(3)
        errors=[]
        def serve():
            try:
                conn,_=listener.accept()
                with conn:
                    conn.settimeout(3);self.assertEqual(g.read_exact(conn,3),b'\x05\x01\x00');conn.sendall(b'\x05\x00')
                    self.assertEqual(g.read_exact(conn,4),b'\x05\x01\x00\x03');n=g.read_exact(conn,1)[0]
                    self.assertEqual(g.read_exact(conn,n),b'test.example.ts.net');self.assertEqual(g.read_exact(conn,2),b'\x00\x16')
                    conn.sendall(b'\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00SSH-fixture')
            except BaseException as e:errors.append(e)
        thread=threading.Thread(target=serve);thread.start()
        try:
            sock=g.socks_connect('test.example.ts.net',22,listener.getsockname());self.assertEqual(sock.recv(512),b'SSH-fixture');sock.close()
        finally:thread.join(4);listener.close()
        self.assertFalse(thread.is_alive());self.assertFalse(errors)
    def http_fixture(self,response):
        left,right=socket.socketpair();left.settimeout(2);right.settimeout(2)
        def serve():
            with right:
                data=b''
                while b'\r\n\r\n' not in data:data+=right.recv(4096)
                self.assertTrue(data.startswith(b'GET / HTTP/1.1'))
                try:right.sendall(response)
                except BrokenPipeError:pass
        thread=threading.Thread(target=serve);thread.start()
        try:return g.execute({'target':'test','kind':'http','port':80,'path':'/'},T,lambda *_:left)
        finally:thread.join(3)
    def test_http_limits_and_no_redirect(self):
        result=self.http_fixture(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');self.assertEqual(base64.b64decode(result['bodyBase64']),b'OK')
        with self.assertRaises(ValueError):self.http_fixture(b'HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: http://evil\r\n\r\n')
        with self.assertRaises(ValueError):self.http_fixture(b'HTTP/1.1 200 OK\r\nContent-Length: 8193\r\n\r\n'+b'x'*8193)
    def test_ssh_only_fixed_command_no_secret(self):
        with patch.object(g, 'bounded_command') as run:
            run.return_value=b'TAILNET_SSH_OK\nroot\n'
            result=g.execute({'target':'test','kind':'ssh','port':22,'user':'root','command':'rm -rf /'},T)
            self.assertTrue(result['ok']);args=run.call_args.args[0];self.assertNotIn('rm -rf /',args);self.assertIn('root@test.example.ts.net',args)
    def test_subprocess_output_cap_and_exit(self):
        self.assertEqual(g.bounded_command(['/bin/sh','-c','printf "TAILNET_SSH_OK\\nroot\\n"']), b'TAILNET_SSH_OK\nroot\n')
        with self.assertRaises(ValueError):g.bounded_command(['/bin/sh','-c','exit 7'])
        with self.assertRaises(ValueError):g.bounded_command(['/bin/sh','-c','head -c 513 /dev/zero'])
    def test_http_auth_and_input_caps(self):
        old=g.TOKEN;g.TOKEN='fixture';server=g.Server(('127.0.0.1',0),g.Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
        try:
            import http.client
            c=http.client.HTTPConnection(*server.server_address,timeout=2);c.request('POST','/run',body='{}');r=c.getresponse();self.assertEqual(r.status,403);r.read();c.close()
            c=http.client.HTTPConnection(*server.server_address,timeout=2);c.request('POST','/run',body='x'*4097,headers={'Authorization':'Bearer fixture'});r=c.getresponse();self.assertEqual(r.status,413);r.read();c.close()
        finally:server.shutdown();server.server_close();thread.join(3);g.TOKEN=old
if __name__=='__main__':unittest.main()
