import { z } from 'zod';

/** Only UUID v4 is accepted as a caller idempotency key. */
export const uuidV4Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'must be a UUID v4',
  );

export const amountCentsSchema = z
  .number()
  .int()
  .positive()
  .max(100_000_00, 'amount exceeds the R$100,000.00 hard ceiling');

export const currencySchema = z.literal('BRL');

const descriptionSchema = z.string().trim().min(1).max(140);

export const createChargeBusinessSchema = z
  .object({
    amount_cents: amountCentsSchema,
    currency: currencySchema.default('BRL'),
    customer_id: z
      .string()
      .trim()
      .regex(/^cus_[a-z0-9_]{1,40}$/i, 'customer_id must match cus_[a-z0-9_]+'),
    description: descriptionSchema.default('charge'),
  })
  .strict();

export const refundBusinessSchema = z
  .object({
    charge_id: z.string().uuid(),
    amount_cents: amountCentsSchema,
    reason: descriptionSchema,
  })
  .strict();

export const sendPixBusinessSchema = z
  .object({
    amount_cents: amountCentsSchema,
    pix_key: z.string().trim().min(3).max(128),
    description: descriptionSchema.default('pix payout'),
  })
  .strict();

export const getBalanceSchema = z
  .object({
    account_id: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const listInvoicesSchema = z
  .object({
    status: z.enum(['open', 'paid', 'overdue', 'void']).optional(),
    customer_id: z.string().trim().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const mutationToolSchema = z.enum([
  'create_charge',
  'refund',
  'send_pix',
]);

export type MutationTool = z.infer<typeof mutationToolSchema>;

export const requestApprovalSchema = z
  .object({
    tool: mutationToolSchema,
    arguments: z.record(z.unknown()),
    idempotency_key: uuidV4Schema,
    justification: z.string().trim().min(10).max(500),
  })
  .strict();

// The token is optional at the schema boundary only so that an idempotent
// replay of an already-approved mutation can return the stored response. A new
// mutation without a token fails closed inside the ledger service.
const approvalTokenSchema = z.string().min(20).optional();

export const createChargeSchema = createChargeBusinessSchema
  .extend({
    idempotency_key: uuidV4Schema,
    approval_token: approvalTokenSchema,
  })
  .strict();

export const refundSchema = refundBusinessSchema
  .extend({
    idempotency_key: uuidV4Schema,
    approval_token: approvalTokenSchema,
  })
  .strict();

export const sendPixSchema = sendPixBusinessSchema
  .extend({
    idempotency_key: uuidV4Schema,
    approval_token: approvalTokenSchema,
  })
  .strict();

export const businessSchemas = {
  create_charge: createChargeBusinessSchema,
  refund: refundBusinessSchema,
  send_pix: sendPixBusinessSchema,
} as const;

export const toolSchemas = {
  create_charge: createChargeSchema,
  refund: refundSchema,
  get_balance: getBalanceSchema,
  list_invoices: listInvoicesSchema,
  send_pix: sendPixSchema,
  request_approval: requestApprovalSchema,
} as const;

export type ToolName = keyof typeof toolSchemas;
export type CreateChargeArgs = z.infer<typeof createChargeSchema>;
export type RefundArgs = z.infer<typeof refundSchema>;
export type SendPixArgs = z.infer<typeof sendPixSchema>;
export type GetBalanceArgs = z.infer<typeof getBalanceSchema>;
export type ListInvoicesArgs = z.infer<typeof listInvoicesSchema>;
export type RequestApprovalArgs = z.infer<typeof requestApprovalSchema>;

export const TOOL_NAMES = Object.keys(toolSchemas) as ToolName[];

export const MUTATION_TOOLS: readonly MutationTool[] = [
  'create_charge',
  'refund',
  'send_pix',
];

export function isMutationTool(name: string): name is MutationTool {
  return (MUTATION_TOOLS as readonly string[]).includes(name);
}

export function parseToolInput<T extends ToolName>(
  tool: T,
  input: unknown,
): z.infer<(typeof toolSchemas)[T]> {
  return toolSchemas[tool].parse(input) as z.infer<(typeof toolSchemas)[T]>;
}
