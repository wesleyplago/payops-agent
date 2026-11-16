import type { Knex } from 'knex';
import type { AppConfig } from '../config';
import { ApprovalService } from '../services/approval';
import { SimulatedGateway } from '../services/gateway';
import { LedgerService } from '../ledger/service';
import { PayOpsTools } from '../tools/registry';
import { AgentRuntime } from '../agent/runtime';
import { BoundedIntentModel } from '../agent/model';
import { RoutedHumanChannel } from './human';

export type Harness = {
  db: Knex;
  config: AppConfig;
  gateway: SimulatedGateway;
  approvals: ApprovalService;
  ledger: LedgerService;
  tools: PayOpsTools;
  agent: AgentRuntime;
  human: RoutedHumanChannel;
};

export function createHarness(db: Knex, config: AppConfig): Harness {
  const human = new RoutedHumanChannel();
  const gateway = new SimulatedGateway();
  const approvals = new ApprovalService(db, config, human);
  const ledger = new LedgerService(db, approvals, gateway);
  const tools = new PayOpsTools(db, config, ledger, approvals);
  const agent = new AgentRuntime(tools, new BoundedIntentModel(), config);
  return { db, config, gateway, approvals, ledger, tools, agent, human };
}
