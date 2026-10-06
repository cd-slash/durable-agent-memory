import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DurableRpcBridge } from './bridge';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log('0.80.5 (durable-agent-memory RPC bridge 0.1.0; compatibility version)');
} else {
  try {
    const configPath = process.env.PI_DURABLE_CONFIG ?? join(homedir(), '.config/durable-agent-memory/bridge.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { url: string; tokenFile: string; sessionsDir?: string };
    const emit = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify(event) + '\n');
    const sessionIndex = args.indexOf('--session');
    const bridge = new DurableRpcBridge({ url: config.url, token: readFileSync(config.tokenFile, 'utf8').trim(), toolsDisabled: args.includes('--no-tools'), sessionsDir: config.sessionsDir ?? join(homedir(), '.local/state/durable-agent-memory/sessions'), emit }, sessionIndex < 0 ? undefined : args[sessionIndex + 1]);
    if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'rpc') throw new Error('Use --mode rpc');
    // T3 injects a local extension. It cannot execute inside the remote Worker.
    if (args.includes('--extension') || args.includes('-e')) process.stderr.write('Pi Durable bridge: local CLI extensions are unavailable; remote tools are defined in the Worker.\n');
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let commands = Promise.resolve();
    input.on('line', line => {
      commands = commands.then(async () => {
        if (line.length > 150000) { emit({ type: 'response', success: false, error: 'RPC line too large' }); return; }
        try { await bridge.handle(JSON.parse(line)); }
        catch { emit({ type: 'response', success: false, error: 'Invalid RPC JSON' }); }
      });
    });
    input.on('close', () => { void commands.then(() => bridge.settled()); });
  } catch { process.stderr.write('Pi Durable bridge startup failed. Check private bridge config, token file and arguments.\n'); process.exitCode = 1; }
}
