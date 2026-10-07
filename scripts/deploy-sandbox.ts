import { SANDBOX_ACTIVATION_BLOCK } from '../src/sandbox/policy';
// Cannot be bypassed by an environment flag or the previous approval argument.
console.error('Sandbox activation blocked: ' + SANDBOX_ACTIVATION_BLOCK);
process.exit(1);
