/** Deliberately conservative, project-wide reservations. Raising requires explicit owner approval. */
export const BILLING_LIMITS = {
  requests: { day: 500, month: 5000 },
  turns: { day: 30, month: 300 },
  aiCalls: { day: 100, month: 1000 },
  neurons: { day: 5000, month: 50000 },
  tools: { day: 100, month: 1000 },
  executions: { day: 10, month: 50 },
  sandboxSeconds: { day: 270, month: 900 },
  sandboxNetworkBytes: { day: 24 * 1048576, month: 80 * 1048576 },
  memories: { day: 20, month: 200 },
  storageBytes: { day: 16 * 1048576, month: 128 * 1048576 },
} as const;
export const MAX_STORAGE_RESERVATION = 128 * 1048576;
export const MAX_AGENTS = 50;
export type BudgetKind = keyof typeof BILLING_LIMITS;
export type Reservation = Partial<Record<BudgetKind, number>>;
export const MAX_AI_INPUT_BYTES = 32768;
export const MAX_AI_OUTPUT_TOKENS = 1024;
export class BillingBlocked extends Error { constructor(public readonly reason = 'Billing safety stop or quota reached') { super(reason); this.name = 'BillingBlocked'; } }
/** Bytes overcount typical text tokens; extra overhead + upward-rounded public neuron rates. */
export function aiReservation(model: string, input: unknown): { reservation: Reservation; input: Record<string, unknown> } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BillingBlocked('Unsupported AI input');
  const object = input as Record<string, unknown>;
  const bytes = new TextEncoder().encode(JSON.stringify(input)).length;
  if (bytes > MAX_AI_INPUT_BYTES) throw new BillingBlocked('AI input exceeds billing-safe context size; intentionally roll over context');
  const inputTokens = bytes + 4096;
  if (model === '@cf/baai/bge-base-en-v1.5') return { reservation: { aiCalls: 1, neurons: Math.ceil(inputTokens * 0.007), storageBytes: 32768 }, input: object };
  if (model !== '@cf/zai-org/glm-4.7-flash') throw new BillingBlocked('AI model has no reviewed billing estimate');
  const outputTokens = Math.min(typeof object.max_tokens === 'number' && Number.isSafeInteger(object.max_tokens) && object.max_tokens > 0 ? object.max_tokens : MAX_AI_OUTPUT_TOKENS, MAX_AI_OUTPUT_TOKENS);
  return { reservation: { aiCalls: 1, neurons: Math.ceil(inputTokens * 0.006 + outputTokens * 0.04), storageBytes: outputTokens * 32 }, input: { ...object, max_tokens: outputTokens, chat_template_kwargs: { enable_thinking: false } } };
}
