/**
 * Child process used by tests/integration/process-kill.test.ts.
 * It starts a real Postgres transaction, writes entries, then blocks. The parent
 * sends SIGKILL. Postgres must roll the transaction back on connection loss.
 */
import { loadConfig, TEST_DATABASE_URL } from '../src/config';
import { createDb } from '../src/db/client';
import { ApprovalService, PendingHumanChannel } from '../src/services/approval';
import { SimulatedGateway } from '../src/services/gateway';
import { LedgerService } from '../src/ledger/service';
import { PayOpsTools } from '../src/tools/registry';

const key = process.env.CRASH_KEY;
const token = process.env.CRASH_TOKEN;
const amount = Number(process.env.CRASH_AMOUNT ?? '4321');
if (!key || !token) throw new Error('CRASH_KEY and CRASH_TOKEN are required');

const base = loadConfig();
const config = { ...base, databaseUrl: TEST_DATABASE_URL, approvalWaitMs: 1000 };
const db = createDb({ url: config.databaseUrl, poolMax: 5, applicationName: 'payops-crash-worker' });
const approvals = new ApprovalService(db, config, new PendingHumanChannel());
const tools = new PayOpsTools(
  db,
  config,
  new LedgerService(db, approvals, new SimulatedGateway()),
  approvals,
);

const pending = tools.execute(
  'create_charge',
  {
    amount_cents: amount,
    currency: 'BRL',
    customer_id: 'cus_crash',
    description: 'real process kill',
    idempotency_key: key,
    approval_token: token,
  },
  { faults: { pauseBeforeCommitMs: 60_000 } },
);

await new Promise((resolve) => setTimeout(resolve, 900));
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\n');
await pending;
