const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const CARD = /\b(?:\d[ -]*?){13,19}\b/g;

export function containsPii(value: string): boolean {
  CPF.lastIndex = 0;
  EMAIL.lastIndex = 0;
  CARD.lastIndex = 0;
  return CPF.test(value) || EMAIL.test(value) || CARD.test(value);
}

export function redactPii(value: string): { text: string; redactions: number } {
  let redactions = 0;
  const replace = (match: string) => {
    redactions += 1;
    return '[REDACTED]';
  };
  CPF.lastIndex = 0;
  EMAIL.lastIndex = 0;
  CARD.lastIndex = 0;
  let text = value.replace(CPF, replace).replace(EMAIL, replace).replace(CARD, replace);
  text = text.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, replace);
  return { text, redactions };
}

export function redactDeep(value: unknown): { value: unknown; redactions: number } {
  if (typeof value === 'string') {
    const result = redactPii(value);
    return { value: result.text, redactions: result.redactions };
  }
  if (Array.isArray(value)) {
    let redactions = 0;
    const out = value.map((item) => {
      const result = redactDeep(item);
      redactions += result.redactions;
      return result.value;
    });
    return { value: out, redactions };
  }
  if (value && typeof value === 'object') {
    let redactions = 0;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = redactDeep(item);
      out[key] = result.value;
      redactions += result.redactions;
    }
    return { value: out, redactions };
  }
  return { value, redactions: 0 };
}
