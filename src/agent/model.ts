export type AgentTool =
  | 'create_charge'
  | 'refund'
  | 'send_pix'
  | 'get_balance'
  | 'list_invoices';

export type ModelDecision = {
  tool: AgentTool;
  arguments: Record<string, unknown>;
  idempotency_key?: string;
  justification: string;
  rationale: string;
};

export type ModelInput = {
  instruction: string;
  intent: ModelDecision;
  /** Sanitized untrusted documents, explicitly a data channel. */
  documents: Array<{ id: string; title: string; content: string; trust: 'untrusted-data' }>;
};

export type ModelUsage = {
  input_tokens: number;
  output_tokens: number;
  model: string;
};

export interface DecisionModel {
  decide(input: ModelInput): Promise<{ decision: ModelDecision; usage: ModelUsage }>;
}

/**
 * Deterministic model boundary used by the harness.
 *
 * The operator submits a structured intent. Documents are untrusted data and
 * are never interpreted as instructions. This is intentionally a *bounded*
 * model: it demonstrates that even a model that only follows the structured
 * intent cannot be steered by the KB. The compromised-model path in the
 * injection suite removes this assumption and attacks the tools directly.
 *
 * A production LLM adapter can implement DecisionModel; the tool boundary and
 * all downstream controls are unchanged.
 */
export class BoundedIntentModel implements DecisionModel {
  async decide(input: ModelInput): Promise<{ decision: ModelDecision; usage: ModelUsage }> {
    return {
      decision: {
        ...input.intent,
        rationale: 'decision derived only from the structured operator intent',
      },
      usage: { input_tokens: 0, output_tokens: 0, model: 'bounded-intent-deterministic' },
    };
  }
}
