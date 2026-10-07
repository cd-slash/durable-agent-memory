import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (!process.argv.includes('--confirm-reviewed-sandbox-costs')) {
  console.error('Activation requires explicit owner approval of docs/SANDBOX.md and its separate billing review. Then pass --confirm-reviewed-sandbox-costs. Existing JavaScript deployment is unaffected.');
  process.exit(1);
}
const docker = spawnSync('docker',['info'],{stdio:'ignore'});
if (docker.status !== 0) {
  console.error('A Docker-capable runner is required to build the coding image. No Cloudflare deployment was attempted.');process.exit(1);
}
if (!existsSync('wrangler.sandbox.jsonc')) process.exit(1);
const deployed = spawnSync('npx',['wrangler','deploy','--config','wrangler.sandbox.jsonc','--var','SANDBOX_ENABLED:true'],{stdio:'inherit',timeout:600000});
process.exit(deployed.status ?? 1);
