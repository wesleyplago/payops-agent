/** All money is integer cents. Never use floating point for ledger arithmetic. */
export function formatBRL(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export function assertPositiveCents(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`amount_cents must be a positive safe integer, got ${value}`);
  }
}
