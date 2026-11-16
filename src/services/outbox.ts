export type OutboxRow = {
  id: string;
  tx_id: string;
  event_type: string;
  payload: { event_id: string; [key: string]: unknown };
  created_at: Date;
  published_at: Date | null;
  attempts: number;
};
