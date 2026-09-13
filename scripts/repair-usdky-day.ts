/**
 * Phase 20: `usdky_snapshots` の欠損日を、前日のスナップショット + その間の
 * トランザクション差分から再構成する。
 *
 * 日次 cron は Helius から「その時点の」全 token account を読む方式なので、
 * 実行できなかった日は後から live 取得では復元できない。ここでは
 *   前日のスナップショット + (前日の cron 時刻, 対象日の cron 時刻] の owner 差分
 * で再構成する。境界時刻は `usdky_multipliers.block_time`（cron が NOW() で打つ）を使い、
 * 行が無い日は cron の実測時刻 23:00:45 UTC を使う。
 *
 *   npx tsx --env-file=.env.local scripts/repair-usdky-day.ts --date 2026-09-11
 *   ... --verify   翌日ぶんも再構成して実データと突合する（手法そのものの検証）
 *   ... --yes      実際に書き込む（既定は再構成して結果を表示するだけ）
 */
import { argv, exit } from 'node:process';
import { getDb, type NeonClient } from '../lib/db';
import { parseTransaction, rpc, sleep, USDKY_DECIMALS, USDKY_MINT } from '../lib/helius';

/** cron (`0 23 * * *`) の実測発火時刻。multiplier 行が無い日の境界に使う */
const CRON_UTC_CLOCK = 'T23:00:45.000Z';
/** getTransaction の間隔（Helius rate limit 対策） */
const RPC_SLEEP_MS = 150;

type SignatureEntry = {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
};

function parseArgs() {
  let date: string | undefined;
  let verify = false;
  let yes = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') date = argv[++i];
    else if (a === '--verify') verify = true;
    else if (a === '--yes') yes = true;
    else {
      console.error(`unknown argument: ${a}`);
      exit(1);
    }
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('Usage: --date YYYY-MM-DD [--verify] [--yes]');
    exit(1);
  }
  return { date, verify, yes };
}

/** その日の cron 実行時刻（= スナップショットの基準時刻）を決める */
async function boundaryFor(sql: NeonClient, date: string): Promise<Date> {
  const rows = (await sql`
    SELECT block_time FROM usdky_multipliers WHERE effective_date = ${date}::date
  `) as Array<{ block_time: Date | string }>;
  if (rows.length > 0) {
    const bt = rows[0].block_time;
    return bt instanceof Date ? bt : new Date(bt);
  }
  return new Date(`${date}${CRON_UTC_CLOCK}`);
}

/** blockTime が (from, to] に入る署名を新しい順にページングして集める */
async function fetchSignaturesInRange(from: Date, to: Date): Promise<SignatureEntry[]> {
  const fromSec = Math.floor(from.getTime() / 1000);
  const toSec = Math.floor(to.getTime() / 1000);
  const collected: SignatureEntry[] = [];
  let before: string | undefined;
  let scanned = 0;

  for (;;) {
    const batch = await rpc<SignatureEntry[]>('getSignaturesForAddress', [
      USDKY_MINT,
      { limit: 1000, ...(before ? { before } : {}) },
    ]);
    if (batch.length === 0) break;
    scanned += batch.length;

    for (const e of batch) {
      if (e.blockTime === null) continue;
      if (e.blockTime > toSec) continue;
      if (e.blockTime <= fromSec) continue;
      collected.push(e);
    }

    const oldest = batch[batch.length - 1];
    console.log(
      `  scanned ${scanned} sigs / in-range ${collected.length} ` +
        `(oldest ${oldest.blockTime ? new Date(oldest.blockTime * 1000).toISOString() : '?'})`,
    );
    if (oldest.blockTime !== null && oldest.blockTime <= fromSec) break;
    if (batch.length < 1000) break;
    before = oldest.signature;
    await sleep(RPC_SLEEP_MS);
  }

  // 古い順に並べ替える
  collected.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0) || a.slot - b.slot);
  return collected;
}

type Balances = Map<string, bigint>;

async function loadSnapshot(sql: NeonClient, date: string): Promise<{
  balances: Balances;
  ataCount: Map<string, number>;
}> {
  const rows = (await sql`
    SELECT owner, principal::text AS principal, ata_count
    FROM usdky_snapshots WHERE snapshot_date = ${date}::date
  `) as Array<{ owner: string; principal: string; ata_count: number }>;
  const balances: Balances = new Map();
  const ataCount = new Map<string, number>();
  for (const r of rows) {
    balances.set(r.owner, BigInt(r.principal));
    ataCount.set(r.owner, r.ata_count);
  }
  return { balances, ataCount };
}

function applyDeltas(
  base: Balances,
  deltas: Array<{ owner: string; delta: bigint }>,
): Balances {
  const out = new Map(base);
  for (const d of deltas) out.set(d.owner, (out.get(d.owner) ?? 0n) + d.delta);
  return out;
}

async function main() {
  const { date, verify, yes } = parseArgs();
  const sql = getDb({ unpooled: true });

  const [prevRow] = (await sql`
    SELECT MAX(snapshot_date)::text AS d FROM usdky_snapshots WHERE snapshot_date < ${date}::date
  `) as Array<{ d: string | null }>;
  const prevDate = prevRow?.d;
  if (!prevDate) {
    console.error(`${date} より前のスナップショットが無いので再構成できない`);
    exit(1);
  }
  const [nextRow] = (await sql`
    SELECT MIN(snapshot_date)::text AS d FROM usdky_snapshots WHERE snapshot_date > ${date}::date
  `) as Array<{ d: string | null }>;
  const nextDate = nextRow?.d ?? null;

  const tPrev = await boundaryFor(sql, prevDate);
  const tTarget = await boundaryFor(sql, date);
  const tNext = verify && nextDate ? await boundaryFor(sql, nextDate) : null;
  const tEnd = tNext ?? tTarget;

  console.log(`前日 ${prevDate} (${tPrev.toISOString()})`);
  console.log(`対象 ${date} (${tTarget.toISOString()})`);
  if (tNext && nextDate) console.log(`検証 ${nextDate} (${tNext.toISOString()})`);

  const { balances: prevBalances, ataCount } = await loadSnapshot(sql, prevDate);
  console.log(`前日の owner 数: ${prevBalances.size}`);

  console.log('\n署名を取得中...');
  const sigs = await fetchSignaturesInRange(tPrev, tEnd);
  const usable = sigs.filter((s) => s.err === null);
  console.log(`対象署名 ${sigs.length} 件（うち成功 ${usable.length} 件を parse）`);

  const deltasBeforeTarget: Array<{ owner: string; delta: bigint }> = [];
  const deltasAfterTarget: Array<{ owner: string; delta: bigint }> = [];
  const multiplierEvents: Array<{ at: Date; multiplier: number }> = [];
  const targetSec = Math.floor(tTarget.getTime() / 1000);
  let nearBoundary = 0;

  for (const [i, s] of usable.entries()) {
    const parsed = await parseTransaction(s.signature);
    const bucket = (s.blockTime ?? 0) <= targetSec ? deltasBeforeTarget : deltasAfterTarget;
    for (const d of parsed.deltas) bucket.push({ owner: d.owner, delta: d.delta });
    if (parsed.multiplierUpdate) {
      multiplierEvents.push({
        at: parsed.multiplierUpdate.blockTime,
        multiplier: parsed.multiplierUpdate.multiplier,
      });
    }
    if (Math.abs((s.blockTime ?? 0) - targetSec) <= 120) nearBoundary += 1;
    if ((i + 1) % 50 === 0 || i === usable.length - 1) {
      console.log(`  parsed [${i + 1} / ${usable.length}]`);
    }
    await sleep(RPC_SLEEP_MS);
  }

  console.log(`\n境界 ±2 分に入る tx: ${nearBoundary} 件（0 なら境界のずれは結果に影響しない）`);
  console.log(`multiplier 更新イベント: ${multiplierEvents.length} 件`);
  for (const e of multiplierEvents) console.log(`  ${e.at.toISOString()} → ${e.multiplier}`);

  // 対象日の multiplier: 境界以前の最新イベント、無ければ DB の直近値
  let multiplier: number | null = null;
  const before = multiplierEvents
    .filter((e) => e.at.getTime() <= tTarget.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .pop();
  if (before) multiplier = before.multiplier;
  if (multiplier === null) {
    const [m] = (await sql`
      SELECT multiplier::text AS m FROM usdky_multipliers
      WHERE block_time <= ${tTarget.toISOString()}::timestamptz
      ORDER BY block_time DESC LIMIT 1
    `) as Array<{ m: string }>;
    multiplier = m ? Number(m.m) : null;
  }
  if (multiplier === null) {
    console.error('multiplier を決められなかった');
    exit(1);
  }
  console.log(`採用する multiplier: ${multiplier}`);

  const targetBalances = applyDeltas(prevBalances, deltasBeforeTarget);
  const positive = [...targetBalances.entries()].filter(([, v]) => v > 0n);
  const totalUsd =
    positive.reduce((s, [, v]) => s + Number(v), 0) / 10 ** USDKY_DECIMALS * multiplier;
  console.log(`\n再構成した ${date}: owners=${positive.length} total_usd=${totalUsd.toFixed(2)}`);

  if (verify && nextDate) {
    const nextBalances = applyDeltas(targetBalances, deltasAfterTarget);
    const { balances: realNext } = await loadSnapshot(sql, nextDate);
    const owners = new Set([...nextBalances.keys(), ...realNext.keys()]);
    let mismatch = 0;
    const samples: string[] = [];
    for (const o of owners) {
      const a = nextBalances.get(o) ?? 0n;
      const b = realNext.get(o) ?? 0n;
      if (a <= 0n && b <= 0n) continue;
      if (a !== b) {
        mismatch += 1;
        if (samples.length < 10) samples.push(`    ${o}: 再構成=${a} 実データ=${b} 差=${a - b}`);
      }
    }
    console.log(`\n=== 検証: ${prevDate} + 差分 → ${nextDate} を実データと突合 ===`);
    console.log(`  owner 数 再構成=${[...nextBalances.values()].filter((v) => v > 0n).length} 実データ=${realNext.size}`);
    if (mismatch === 0) {
      console.log('  完全一致 — 差分の取得と適用は正しい');
    } else {
      console.log(`  不一致 ${mismatch} owner:`);
      for (const s of samples) console.log(s);
    }
  }

  if (!yes) {
    console.log('\n--yes が無いので書き込まない');
    return;
  }

  const owners = positive.map(([o]) => o);
  const principals = positive.map(([, v]) => v.toString());
  const ataCounts = positive.map(([o]) => ataCount.get(o) ?? 1);

  const BATCH = 500;
  for (let i = 0; i < owners.length; i += BATCH) {
    await sql`
      INSERT INTO usdky_snapshots (snapshot_date, owner, principal, multiplier, usd_value, ata_count)
      SELECT ${date}::date, owner, principal, ${multiplier}::numeric,
             (principal::numeric / ${10 ** USDKY_DECIMALS}::numeric) * ${multiplier}::numeric,
             ata_count
      FROM UNNEST(
        ${owners.slice(i, i + BATCH)}::text[],
        ${principals.slice(i, i + BATCH)}::numeric[],
        ${ataCounts.slice(i, i + BATCH)}::int[]
      ) AS t(owner, principal, ata_count)
      ON CONFLICT (snapshot_date, owner) DO UPDATE
      SET principal = EXCLUDED.principal,
          multiplier = EXCLUDED.multiplier,
          usd_value = EXCLUDED.usd_value,
          ata_count = EXCLUDED.ata_count
    `;
    console.log(`  inserted [${Math.min(i + BATCH, owners.length)} / ${owners.length}]`);
  }

  // multiplier 履歴にも印を残す（cron が打つ行と区別できる signature を使う）
  await sql`
    INSERT INTO usdky_multipliers (effective_date, multiplier, block_time, signature)
    VALUES (${date}::date, ${multiplier}::numeric, ${tTarget.toISOString()}::timestamptz, ${`repair-${date}`})
    ON CONFLICT (effective_date) DO NOTHING
  `;
  console.log(`\n${date} を ${owners.length} owner で書き込み完了`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
