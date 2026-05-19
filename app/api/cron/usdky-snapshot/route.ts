import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getAllTokenAccounts, getMultiplier, USDKY_DECIMALS } from '@/lib/helius';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'cron not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const multiplier = await getMultiplier();
  const accounts = await getAllTokenAccounts();

  const byOwner = new Map<string, { principal: bigint; ataCount: number }>();
  for (const a of accounts) {
    if (a.frozen) continue;
    const principal = BigInt(typeof a.amount === 'string' ? a.amount : a.amount.toString());
    const existing = byOwner.get(a.owner);
    if (existing) {
      existing.principal += principal;
      existing.ataCount += 1;
    } else {
      byOwner.set(a.owner, { principal, ataCount: 1 });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows = [...byOwner.entries()]
    .filter(([, v]) => v.principal > 0n)
    .map(([owner, v]) => ({
      owner,
      principal: v.principal.toString(),
      ata_count: v.ataCount,
    }));

  const db = getDb();

  // usd_value computed in SQL to preserve full numeric precision.
  if (rows.length > 0) {
    await db`
      INSERT INTO usdky_snapshots (snapshot_date, owner, principal, multiplier, usd_value, ata_count)
      SELECT
        ${today}::date,
        owner,
        principal,
        ${multiplier}::numeric,
        (principal::numeric / ${10 ** USDKY_DECIMALS}::numeric) * ${multiplier}::numeric,
        ata_count
      FROM UNNEST(
        ${rows.map((r) => r.owner)}::text[],
        ${rows.map((r) => r.principal)}::numeric[],
        ${rows.map((r) => r.ata_count)}::int[]
      ) AS t(owner, principal, ata_count)
      ON CONFLICT (snapshot_date, owner) DO UPDATE
      SET principal = EXCLUDED.principal,
          multiplier = EXCLUDED.multiplier,
          usd_value = EXCLUDED.usd_value,
          ata_count = EXCLUDED.ata_count
    `;
  }

  // Stamp today's multiplier. The signature column is required but no on-chain
  // tx is available here, so use a synthetic 'cron-YYYY-MM-DD' marker. Real
  // multiplier-update rows from backfill carry higher block_time precision and
  // the WHERE clause keeps them.
  await db`
    INSERT INTO usdky_multipliers (effective_date, multiplier, block_time, signature)
    VALUES (${today}::date, ${multiplier}::numeric, NOW(), ${`cron-${today}`})
    ON CONFLICT (effective_date) DO UPDATE
    SET multiplier = EXCLUDED.multiplier,
        block_time = EXCLUDED.block_time,
        signature = EXCLUDED.signature
    WHERE EXCLUDED.block_time > usdky_multipliers.block_time
  `;

  const totalUsd = rows.reduce(
    (s, r) => s + (Number(r.principal) / 10 ** USDKY_DECIMALS) * multiplier,
    0,
  );

  return NextResponse.json({
    snapshot_date: today,
    holders: rows.length,
    total_usd: totalUsd,
    multiplier,
  });
}
