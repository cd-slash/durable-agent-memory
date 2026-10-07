#!/usr/bin/env python3
"""Mint ONE expiring ephemeral gateway key and store only in a Cloudflare secret.
Never prints credentials. Dedicated tag must already exist in the owner's ACL.
"""
import argparse, json, os, shlex, urllib.request, urllib.error
ACCOUNT='efceafa29432e7f5d5fc86703f78d81b'
WORKER='durable-agent-memory'
def load_env(path):
    values=dict(os.environ)
    with open(path) as file:
        for line in file:
            for item in shlex.split(line,comments=True):
                if '=' in item:
                    key,value=item.split('=',1);values.setdefault(key,value)
    return values

def api(method,url,token,body=None):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(url,data=data,method=method,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=15) as response:
            data=response.read(65537)
            if len(data)>65536:raise RuntimeError('Administrative response too large')
            return json.loads(data) if data else {}
    except urllib.error.HTTPError as e:raise RuntimeError('Administrative API rejected operation: HTTP '+str(e.code)) from None

def provision(values,tailnet,tag,call=api):
    ts=values.get('TAILSCALE_API_TOKEN') or values.get('TAILSCALE_API_KEY')
    cf=values.get('CLOUDFLARE_API_TOKEN') or values.get('CLOUDFLARE_API_KEY')
    if not ts or not cf:raise RuntimeError('Configure Tailscale management and Cloudflare credentials locally; no mutation attempted')
    if tag!='tag:hm-tailnet-gateway':raise RuntimeError('Use dedicated tag:hm-tailnet-gateway; never an admin tag')
    from urllib.parse import quote
    url='https://api.tailscale.com/api/v2/tailnet/'+quote(tailnet,safe='')+'/keys'
    created=call('POST',url,ts,{'capabilities':{'devices':{'create':{'reusable':True,'ephemeral':True,'preauthorized':True,'tags':[tag]}}},'expirySeconds':86400,'description':'Bounded Cloudflare hybrid memory gateway'})
    key=created.get('key');key_id=created.get('id')
    if not key_id or not isinstance(key,str) or not key.startswith('tskey-auth-'):raise RuntimeError('Key API returned invalid shape; inspect Tailscale admin console')
    try:
        result=call('PUT','https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/workers/scripts/'+WORKER+'/secrets',cf,{'name':'TAILSCALE_AUTH_KEY','text':key,'type':'secret_text'})
        if not result.get('success'):raise RuntimeError('Cloudflare secret storage failed')
    except Exception:
        try:call('DELETE',url+'/'+quote(key_id,safe=''),ts)
        except Exception:raise RuntimeError('Secret upload failed and key revocation unconfirmed; revoke gateway key in Tailscale admin console') from None
        raise RuntimeError('Secret upload failed; newly minted key revoked') from None
    return {'keyId':key_id,'tailnet':tailnet,'tag':tag,'expirySeconds':86400,'secretName':'TAILSCALE_AUTH_KEY','worker':WORKER}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--env-file',default='/home/coder/.env');parser.add_argument('--tailnet',required=True);parser.add_argument('--tag',default='tag:hm-tailnet-gateway');args=parser.parse_args()
    receipt=provision(load_env(args.env_file),args.tailnet,args.tag)
    path=os.path.expanduser('~/.config/durable-agent-memory/tailnet-key-receipt.json');os.makedirs(os.path.dirname(path),mode=0o700,exist_ok=True)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as file:json.dump(receipt,file)
    print('Fresh ephemeral key stored as Cloudflare secret TAILSCALE_AUTH_KEY; metadata-only receipt saved privately. Expires in one day; no automatic renewal.')
if __name__=='__main__':
    try:main()
    except Exception as e:
        # Only our bounded generic errors; never echo HTTP bodies/credentials.
        print(str(e) if isinstance(e,RuntimeError) else 'Provisioning failed; inspect local configuration without printing secrets')
        raise SystemExit(1)
