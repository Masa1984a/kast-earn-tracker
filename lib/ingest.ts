import type { NeonClient } from './db';

type SnapshotRow = {
  snapshot_date: string;
  holder_address: string;
  gtusda_balance: number | string;
};

type PriceRow = {
  effective_date: string;
  share_price: number | string;
  enter_events_today?: number | string;
  daily_volume_usdc?: number | string;
};

type KastWalletRow = {
  wallet: string;
  first_funded_at: string;
};

const SNAPSHOT_BATCH = 500;

export async function ingestJobResults(
  sql: NeonClient,
  jobKind: string,
  rows: unknown[],
): Promise<{ inserted: number }> {
  if (jobKind === 'gauntlet_daily' || jobKind === 'gauntlet_backfill') {
    return ingestGauntletSnapshots(sql, rows as SnapshotRow[]);
  }
  if (jobKind === 'gauntlet_price' || jobKind === 'gauntlet_price_backfill') {
    return ingestGauntletPrices(sql, rows as PriceRow[]);
  }
  if (jobKind === 'kast_base_wallets_daily' || jobKind === 'kast_base_wallets_backfill') {
    return ingestKastBaseWallets(sql, rows as KastWalletRow[]);
  }
  throw new Error(`Unknown job_kind: ${jobKind}`);
}

function dateKey(d: string | Date): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

async function ingestGauntletSnapshots(
  sql: NeonClient,
  rows: SnapshotRow[],
): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };

  const uniqueDates = [...new Set(rows.map((r) => dateKey(r.snapshot_date)))];
  const priceRows = (await sql`
    SELECT effective_date, share_price
    FROM gauntlet_share_prices
    WHERE effective_date = ANY(${uniqueDates}::date[])
  `) as Array<{ effective_date: Date | string; share_price: number | string }>;

  const priceMap = new Map<string, number>(
    priceRows.map((r) => [dateKey(r.effective_date), Number(r.share_price)]),
  );

  let total = 0;
  for (let i = 0; i < rows.length; i += SNAPSHOT_BATCH) {
    const batch = rows.slice(i, i + SNAPSHOT_BATCH);
    const dates = batch.map((r) => dateKey(r.snapshot_date));
    const holders = batch.map((r) => r.holder_address);
    const shares = batch.map((r) => Number(r.gtusda_balance));
    const prices = dates.map((d) => priceMap.get(d) ?? 1.0);
    const usdValues = shares.map((s, idx) => s * prices[idx]);

    await sql`
      INSERT INTO gauntlet_snapshots (snapshot_date, holder, shares, share_price, usd_value)
      SELECT * FROM unnest(
        ${dates}::date[],
        ${holders}::text[],
        ${shares}::numeric[],
        ${prices}::numeric[],
        ${usdValues}::numeric[]
      )
      ON CONFLICT (snapshot_date, holder) DO UPDATE SET
        shares = excluded.shares,
        share_price = excluded.share_price,
        usd_value = excluded.usd_value
    `;
    total += batch.length;
  }

  return { inserted: total };
}

async function ingestGauntletPrices(
  sql: NeonClient,
  rows: PriceRow[],
): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };

  const dates = rows.map((r) => dateKey(r.effective_date));
  const prices = rows.map((r) => Number(r.share_price));
  const eventCounts = rows.map((r) => Number(r.enter_events_today ?? 0));
  const volumes = rows.map((r) => Number(r.daily_volume_usdc ?? 0));

  await sql`
    INSERT INTO gauntlet_share_prices
      (effective_date, share_price, enter_events_today, daily_volume_usdc)
    SELECT * FROM unnest(
      ${dates}::date[],
      ${prices}::numeric[],
      ${eventCounts}::int[],
      ${volumes}::numeric[]
    )
    ON CONFLICT (effective_date) DO UPDATE SET
      share_price = excluded.share_price,
      enter_events_today = excluded.enter_events_today,
      daily_volume_usdc = excluded.daily_volume_usdc
  `;

  await sql`
    UPDATE gauntlet_snapshots gs
    SET
      share_price = gp.share_price,
      usd_value   = gs.shares * gp.share_price
    FROM gauntlet_share_prices gp
    WHERE gs.snapshot_date = gp.effective_date
      AND gs.snapshot_date = ANY(${dates}::date[])
      AND (gs.share_price IS DISTINCT FROM gp.share_price
           OR gs.usd_value IS DISTINCT FROM gs.shares * gp.share_price)
  `;

  return { inserted: rows.length };
}

async function ingestKastBaseWallets(
  sql: NeonClient,
  rows: KastWalletRow[],
): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };

  let total = 0;
  for (let i = 0; i < rows.length; i += SNAPSHOT_BATCH) {
    const batch = rows.slice(i, i + SNAPSHOT_BATCH);
    const wallets = batch.map((r) => r.wallet);
    const fundedAts = batch.map((r) => r.first_funded_at);

    await sql`
      INSERT INTO kast_base_wallets (wallet, first_funded_at, last_updated_at)
      SELECT * FROM unnest(
        ${wallets}::text[],
        ${fundedAts}::timestamptz[],
        ${Array(batch.length).fill(new Date().toISOString())}::timestamptz[]
      )
      ON CONFLICT (wallet) DO UPDATE SET
        last_updated_at = excluded.last_updated_at
    `;
    total += batch.length;
  }

  return { inserted: total };
}
