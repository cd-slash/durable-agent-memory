import type { ScoreSignals, ScoreWeights } from './types';
export const defaultWeights: ScoreWeights = { semantic: 0.6, lexical: 0.3, recency: 0.1 };
export function weightedScore(signals: ScoreSignals, weights: ScoreWeights): number {
  return signals.semantic * weights.semantic + signals.lexical * weights.lexical + signals.recency * weights.recency;
}
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? Math.max(0, Math.min(1, dot / Math.sqrt(aa * bb))) : 0;
}
export function validateVector(vector: number[]): void {
  if (!Array.isArray(vector) || !vector.length || vector.some(v => !Number.isFinite(v))) throw new Error('Invalid embedding vector');
}
