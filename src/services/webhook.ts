import type { Knex } from 'knex';
import type { OutboxRow } from './outbox';

export type DeliveryResult = {
  event_id: string;
  duplicate: boolean;
};

/**
 * At-least-once webhook receiver. The primary key on event_id makes duplicate
 * delivery harmless, which is the receiving half of the outbox contract.
 */
export class WebhookReceiver {
  readonly stats = { received: 0, duplicates: 0, accepted: 0 };

  constructor(private readonly db: Knex) {}

  async receive(event: { event_id: string; [key: string]: unknown }): Promise<DeliveryResult> {
    this.stats.received += 1;
    const inserted = await this.db('webhook_deliveries')
      .insert({ event_id: event.event_id, payload: event })
      .onConflict('event_id')
      .ignore()
      .returning('event_id');
    if (inserted.length === 0) {
      this.stats.duplicates += 1;
      return { event_id: event.event_id, duplicate: true };
    }
    this.stats.accepted += 1;
    return { event_id: event.event_id, duplicate: false };
  }

  async deliverOutbox(row: OutboxRow): Promise<DeliveryResult> {
    return this.receive(row.payload);
  }
}
