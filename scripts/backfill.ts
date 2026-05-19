import { argv, env, exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { getDb } from '../lib/db';
import {
  USDKY_MINT,
  USDKY_DECIMALS,
  parseTransaction,
  rpc,
  sleep,
} from '../lib/helius';

const SLEEP_MS = 150;
const TX_BATCH_SIZE = 500;
const MULT_BATCH_SIZE = 50;

interface Args {
  from?: string; // YYYY-MM-DD inclusive lower bound on blockTime
  yes: boolean;
  skipSnapshots: boolean;
}

function parseArgs(): Args {
  const args: Args = { yes: false, skipSnapshots: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') args.from = argv[++i];
    else if (a === '--yes') args.yes = true;
    else if (a === '--skip-snapshots') args.skipSnapshots = true;
    else {
      console.error(`unknown argument: ${a}`);
      exit(1);
    }
  }
  return args;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
  rl.close();
  return ans === 'y' || ans === 'yes';
}

interface SignatureEntry {
  signature: string;
  blockTime: number | null;
  slot: number;
  err: unknown;
}

async function fetchAllSignatures(fromTimestamp: number | null): Promise<SignatureEntry[]> {
  const out: SignatureEntry[] = [];
  let before: string | undefined;
  while (true) {
    const params: [string, Record<string, unknown>] = [
      USDKY_MINT,
      { limit: 1000, ...(before ? { before } : {}) },
    ];
    const batch = await rpc<SignatureEntry[]>('getSignaturesForAddress', params);
    if (batch.length === 0) break;

    if (fromTimestamp !== null) {
      const inRange = batch.filter((s) => (s.blockTime ?? 0) >= fromTimestamp);
      out.push(...inRange);
      if (inRange.length < batch.length) break; // crossed below the floor
    } else {
      out.push(...batch);
    }
    const earliest = batch[batch.length - 1].blockTime;
    const iso = earliest ? new Date(earliest * 1000).toISOString().slice(0, 10) : '?';
    console.log(`  fetched ${out.length} signatures (earliest in batch: ${iso})`);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
    await sleep(SLEEP_MS);
  }
  return out;
}

type Db = ReturnType<typeof getDb>;

interface TxLogRow {
  signature: string;
  block_time: string;
  owner: string;
  delta: string;
  kind: string;
}
interface MultRow {
  effective_date: string;
  multiplier: string;
  block_time: string;
  signature: string;
}

async function flushTxLog(db: Db, rows: TxLogRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db`
    INSERT INTO usdky_tx_log (signature, block_time, owner, delta, kind)
    SELECT * FROM UNNEST(
      ${rows.map((r) => r.signature)}::text[],
      ${rows.map((r) => r.block_time)}::timestamptz[],
      ${rows.map((r) => r.owner)}::text[],
      ${rows.map((r) => r.delta)}::numeric[],
      ${rows.map((r) => r.kind)}::text[]
    )
    ON CONFLICT (signature, owner) DO NOTHING
  `;
}

async function flushMultipliers(db: Db, rows: MultRow[]): Promise<void> {
  if (rows.length === 0) return;
  // Postgres rejects ON CONFLICT DO UPDATE when the same conflict key appears
  // twice in the source rows, so dedupe by effective_date first.
  const byDate = new Map<string, MultRow>();
  for (const r of rows) {
    const existing = byDate.get(r.effective_date);
    if (!existing || r.block_time > existing.block_time) {
      byDate.set(r.effective_date, r);
    }
  }
  const deduped = [...byDate.values()];
  await db`
    INSERT INTO usdky_multipliers (effective_date, multiplier, block_time, signature)
    SELECT * FROM UNNEST(
      ${deduped.map((r) => r.effective_date)}::date[],
      ${deduped.map((r) => r.multiplier)}::numeric[],
      ${deduped.map((r) => r.block_time)}::timestamptz[],
      ${deduped.map((r) => r.signature)}::text[]
    )
    ON CONFLICT (effective_date) DO UPDATE
    SET multiplier = EXCLUDED.multiplier,
        block_time = EXCLUDED.block_time,
        signature = EXCLUDED.signature
    WHERE EXCLUDED.block_time > usdky_multipliers.block_time
  `;
}

async function reconstructSnapshots(db: Db): Promise<void> {
  console.log('[step 5] reconstructing daily snapshots from usdky_tx_log...');

  const [{ min, max }] = (await db`
    SELECT MIN(block_time)::date AS min, CURRENT_DATE AS max FROM usdky_tx_log
  `) as Array<{ min: string | null; max: string }>;
  if (!min) {
    console.log('  no tx_log rows yet — skipping snapshot reconstruction');
    return;
  }
  console.log(`  reconstructing ${min} .. ${max}`);

  // Generate per-day per-owner principal as a running sum of deltas, then
  // join the day's effective multiplier. ata_count defaults to 1 in backfill;
  // the daily cron will overwrite it with the live count.
  await db`
    INSERT INTO usdky_snapshots (snapshot_date, owner, principal, multiplier, usd_value, ata_count)
    WITH days AS (
      SELECT generate_series(${min}::date, ${max}::date, '1 day'::interval)::date AS d
    ),
    owner_day AS (
      SELECT d.d AS snapshot_date, t.owner, SUM(t.delta) AS principal
      FROM days d
      JOIN usdky_tx_log t ON t.block_time::date <= d.d
      GROUP BY d.d, t.owner
      HAVING SUM(t.delta) > 0
    ),
    day_multiplier AS (
      SELECT d.d AS snapshot_date,
             (SELECT m.multiplier FROM usdky_multipliers m
              WHERE m.effective_date <= d.d
              ORDER BY m.effective_date DESC LIMIT 1) AS multiplier
      FROM days d
    )
    SELECT
      od.snapshot_date,
      od.owner,
      od.principal,
      COALESCE(dm.multiplier, 1.0) AS multiplier,
      (od.principal::numeric / ${10 ** USDKY_DECIMALS}::numeric) * COALESCE(dm.multiplier, 1.0) AS usd_value,
      1 AS ata_count
    FROM owner_day od
    JOIN day_multiplier dm ON dm.snapshot_date = od.snapshot_date
    ON CONFLICT (snapshot_date, owner) DO UPDATE
    SET principal = EXCLUDED.principal,
        multiplier = EXCLUDED.multiplier,
        usd_value = EXCLUDED.usd_value
  `;

  const [counts] = (await db`
    SELECT COUNT(*)::int AS rows,
           COUNT(DISTINCT snapshot_date)::int AS days,
           COUNT(DISTINCT owner)::int AS owners
    FROM usdky_snapshots
  `) as Array<{ rows: number; days: number; owners: number }>;
  console.log(
    `  usdky_snapshots: ${counts.rows} rows / ${counts.days} days / ${counts.owners} owners`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!env.HELIUS_API_KEY) {
    console.error('HELIUS_API_KEY not set');
    exit(1);
  }
  const db = getDb({ unpooled: true });

  let fromTs: number | null = null;
  if (args.from) {
    const t = Math.floor(new Date(`${args.from}T00:00:00Z`).getTime() / 1000);
    if (!Number.isFinite(t)) {
      console.error(`invalid --from: ${args.from}`);
      exit(1);
    }
    fromTs = t;
  }

  console.log(`[step 1] fetching signatures${args.from ? ` from ${args.from}` : ''}...`);
  const sigs = await fetchAllSignatures(fromTs);
  const successful = sigs.filter((s) => s.err === null);
  console.log(`[step 1] total: ${sigs.length} (${successful.length} successful)`);

  if (!args.yes) {
    const ok = await confirm(
      `Process ${successful.length} successful transactions? (~${successful.length} Helius credits)`,
    );
    if (!ok) {
      console.log('Aborted.');
      exit(0);
    }
  }

  // Oldest → newest so multiplier updates are upserted in chronological order.
  successful.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));

  console.log('[step 2-4] fetching and parsing transactions...');
  let txLogBuf: TxLogRow[] = [];
  let multBuf: MultRow[] = [];
  let nDeltaRows = 0;
  let nMultUpdates = 0;
  let nProcessed = 0;
  let nErrors = 0;
  const total = successful.length;

  for (const sig of successful) {
    nProcessed++;
    try {
      const parsed = await parseTransaction(sig.signature);
      if (parsed.blockTime) {
        const iso = parsed.blockTime.toISOString();
        for (const d of parsed.deltas) {
          if (d.delta === 0n) continue;
          txLogBuf.push({
            signature: parsed.signature,
            block_time: iso,
            owner: d.owner,
            delta: d.delta.toString(),
            kind: d.kind,
          });
        }
        if (parsed.multiplierUpdate) {
          multBuf.push({
            effective_date: parsed.multiplierUpdate.blockTime
              .toISOString()
              .slice(0, 10),
            multiplier: parsed.multiplierUpdate.multiplier.toString(),
            block_time: parsed.multiplierUpdate.blockTime.toISOString(),
            signature: parsed.signature,
          });
          nMultUpdates++;
        }
      }
    } catch (err) {
      nErrors++;
      console.error(`  failed ${sig.signature}: ${(err as Error).message}`);
    }

    if (txLogBuf.length >= TX_BATCH_SIZE) {
      await flushTxLog(db, txLogBuf);
      nDeltaRows += txLogBuf.length;
      txLogBuf = [];
    }
    if (multBuf.length >= MULT_BATCH_SIZE) {
      await flushMultipliers(db, multBuf);
      multBuf = [];
    }

    if (nProcessed % 50 === 0 || nProcessed === total) {
      console.log(
        `  [${nProcessed} / ${total}] ${nDeltaRows + txLogBuf.length} delta rows, ${nMultUpdates} mult updates, ${nErrors} errors`,
      );
    }
    await sleep(SLEEP_MS);
  }

  if (txLogBuf.length > 0) {
    await flushTxLog(db, txLogBuf);
    nDeltaRows += txLogBuf.length;
  }
  if (multBuf.length > 0) {
    await flushMultipliers(db, multBuf);
  }
  console.log(
    `[step 2-4] done: ${nDeltaRows} delta rows inserted, ${nMultUpdates} multiplier updates, ${nErrors} errors`,
  );

  if (!args.skipSnapshots) {
    await reconstructSnapshots(db);
  } else {
    console.log('[step 5] skipped (--skip-snapshots)');
  }

  console.log('Backfill complete.');
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
