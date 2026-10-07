import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { SANDBOX } from '../src/sandbox/policy';
import { BILLING_LIMITS, MAX_AGENTS, MAX_STORAGE_RESERVATION } from '../src/billing/policy';
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const baseIndex = process.argv.indexOf('--base');
const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : undefined;
const staged = process.argv.includes('--staged');
let changed: string[], added: string[];
if (base && !/^0+$/.test(base)) {
  changed = git('diff', '--name-only', `${base}..HEAD`); added = git('diff', '--diff-filter=A', '--name-only', `${base}..HEAD`);
} else if (staged) {
  changed = git('diff', '--cached', '--name-only'); added = git('diff', '--cached', '--diff-filter=A', '--name-only');
} else {
  const untracked = git('ls-files', '--others', '--exclude-standard');
  changed = [...git('diff', '--name-only'), ...git('diff', '--cached', '--name-only'), ...untracked];
  added = [...git('diff', '--cached', '--diff-filter=A', '--name-only'), ...untracked];
}
const reviews = added.filter(p => /^\.agents\/billing-reviews\/[a-zA-Z0-9_.-]+\.md$/.test(p));
if (changed.length) {
  assert.ok(reviews.length, 'Every change requires a NEW .agents/billing-reviews/*.md assessment, including documentation-only changes');
  for (const path of reviews) {
    const text = staged ? execFileSync('git', ['show', `:${path}`], { encoding: 'utf8' }) : readFileSync(path, 'utf8');
    for (const heading of ['Change', 'Billable paths', 'Worst-case bounds', 'Failure and retry', 'Emergency stop', 'Validation', 'Residual risks']) assert.match(text, new RegExp(`## ${heading}\\s+\\S`), `${path}: missing ${heading}`);
    assert.ok(!/\b(TODO|TBD)\b/.test(text), 'Billing reviews must describe actual evidence');
  }
}
for (const file of ['wrangler.jsonc', 'wrangler.execution.jsonc', 'wrangler.sandbox.jsonc', 'wrangler.tailnet.jsonc']) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(config.durable_objects.bindings.some((b: any) => b.name === 'BILLING' && b.class_name === 'BillingControl'), 'Global billing binding required');
  assert.ok(config.migrations.some((m: any) => m.new_sqlite_classes?.includes('BillingControl')), 'Billing migration required');
  assert.ok(config.limits.cpu_ms > 0 && config.limits.cpu_ms <= 50, 'CPU ceiling changed: owner approval and policy update required');
  assert.ok(config.observability.head_sampling_rate <= 0.1, 'Logging spend must remain bounded');
  assert.equal(config.preview_urls, false, 'Public preview URLs must remain disabled');
}
assert.ok(BILLING_LIMITS.neurons.day <= 5000 && BILLING_LIMITS.neurons.month <= 50000, 'AI budget increase requires owner approval and reviewer-visible policy update');
assert.ok(BILLING_LIMITS.executions.day <= 10 && BILLING_LIMITS.executions.month <= 50);
assert.ok(BILLING_LIMITS.requests.month <= 5000 && BILLING_LIMITS.turns.month <= 300);
assert.ok(MAX_AGENTS <= 50 && MAX_STORAGE_RESERVATION <= 128 * 1048576);
assert.ok(BILLING_LIMITS.storageBytes.day <= 16 * 1048576);
assert.ok(!readFileSync('.github/workflows/check.yml','utf8').includes('test:hosted'), 'CI must not run paid tests');
console.log(`PASS: billing policy/config checks; ${changed.length} changed paths, ${reviews.length} new documented risk reviews. This is a review gate, not a proof of zero billing risk.`);

const sandboxConfig = JSON.parse(readFileSync('wrangler.sandbox.jsonc','utf8'));
assert.equal(sandboxConfig.vars.SANDBOX_ENABLED, 'false', 'Sandbox stays opt-in; activation requires explicit deployment confirmation');
assert.equal(sandboxConfig.containers.length,1);
assert.equal(sandboxConfig.containers[0].scheduling_policy,'durable_object');
assert.ok(SANDBOX.leaseMs <= 90000 && SANDBOX.maxCommandMs <= 30000 && SANDBOX.containerLifetimeSeconds <= 75);
assert.ok(SANDBOX.checkpointBytes <= 2*1048576 && SANDBOX.networkBytes <= 8*1048576);
assert.ok(BILLING_LIMITS.sandboxSeconds.day <= 270 && BILLING_LIMITS.sandboxSeconds.month <= 900);
assert.ok(BILLING_LIMITS.sandboxNetworkBytes.month <= 80*1048576);

const tailnetConfig = JSON.parse(readFileSync("wrangler.tailnet.jsonc","utf8"));
assert.equal(tailnetConfig.vars.TAILNET_ENABLED,"false");
assert.equal(tailnetConfig.vars.TAILNET_TARGETS,"[]");
assert.equal(tailnetConfig.containers.length,1);
assert.equal(tailnetConfig.containers[0].max_instances,1);
assert.equal(tailnetConfig.containers[0].scheduling_policy,"default");
assert.equal(tailnetConfig.containers[0].instance_type,"lite");
assert.ok(!JSON.stringify(tailnetConfig).includes("tskey-"));
