export const ACCOUNTS = {
  CASH: 'acc_cash',
  REVENUE: 'acc_revenue',
  REFUNDS: 'acc_refunds',
  PIX_EXPENSE: 'acc_pix_expense',
} as const;

export const ACCOUNT_SEED = [
  {
    id: ACCOUNTS.CASH,
    name: 'Cash / settlement',
    type: 'asset',
    normal_balance: 'debit',
  },
  {
    id: ACCOUNTS.REVENUE,
    name: 'Card revenue',
    type: 'revenue',
    normal_balance: 'credit',
  },
  {
    id: ACCOUNTS.REFUNDS,
    name: 'Refunds (contra-revenue)',
    type: 'expense',
    normal_balance: 'debit',
  },
  {
    id: ACCOUNTS.PIX_EXPENSE,
    name: 'Pix payouts',
    type: 'expense',
    normal_balance: 'debit',
  },
] as const;

export type AccountId = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];
