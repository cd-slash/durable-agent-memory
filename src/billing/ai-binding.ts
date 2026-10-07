import { aiReservation, type Reservation } from './policy';
export interface BudgetReserver { reserve(reservation: Reservation): Promise<void> }
/** Every provider attempt, retry, summary and embedding must reserve before AI.run. */
export function guardedAI(binding: Ai, billing: BudgetReserver): Ai {
  return new Proxy(binding, { get(target, key) {
    if (key === 'run') return async (model: string, input: unknown, options?: unknown) => {
      const checked = aiReservation(model, input);
      await billing.reserve(checked.reservation);
      return Reflect.apply(target.run, target, [model, checked.input, options]);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
