export const SANDBOX_ACTIVATION_BLOCK = 'Cloudflare durable_object scheduling grants exec processes root capabilities; reviewed isolation/lifetime redesign required before activation';
/** Proposed sandbox ceilings; activation requires separate owner approval. */
export const SANDBOX = Object.freeze({
  leaseMs: 90_000, containerLifetimeSeconds: 75,
  commandMs: 20_000, maxCommandMs: 30_000,
  commandBytes: 16_384, outputBytes: 8_192,
  checkpointBytes: 2 * 1048576, checkpointWireBytes: 2_800_000,
  storageReservation: 6 * 1048576,
  networkBytes: 8 * 1048576, responseBytes: 2 * 1048576,
  requestBytes: 32768, networkRequests: 16,
  attemptsDay: 3, attemptsMonth: 10,
});
export interface ShellInput { agent: string; operationId: string; command: string; timeoutMs?: number }
export interface ShellResult {
  exitCode: number; stdout: string; stderr: string; checkpointed: boolean;
  error?: string;
}
export function validateShell(input: ShellInput) {
  if (!input || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.agent) || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId)
    || typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0')
    || new TextEncoder().encode(input.command).length > SANDBOX.commandBytes
    || (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > SANDBOX.maxCommandMs)))
    throw new Error('Invalid or oversized shell request');
}
