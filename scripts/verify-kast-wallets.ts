/**
 * Phase 10 検証: kast_base_wallets の取り込み確認
 */
import { exit } from 'node:process';
import { getDb } from '../lib/db';

const PROBE_WALLET = '0x371002be73300a256cf9376e2f4a59ee00902cae';

async function main() {
  const sql = getDb({ unpooled: true });

  console.log('--- kast_base_wallets aggregates ---');
  const [agg] = (await sql`
    SELECT
      COUNT(*) AS total,
      MIN(first_funded_at) AS earliest,
      MAX(first_funded_at) AS latest,
      MAX(last_updated_at) AS last_ingest
    FROM kast_base_wallets
  `) as Array<Record<string, unknown>>;
  console.log(agg);

  console.log('\n--- probe wallet in kast_base_wallets ---');
  const probe = (await sql`
    SELECT wallet, first_funded_at, last_updated_at, source
    FROM kast_base_wallets
    WHERE wallet = ${PROBE_WALLET}
  `) as Array<Record<string, unknown>>;
  if (probe.length === 0) {
    console.log(`NOT FOUND: ${PROBE_WALLET}`);
  } else {
    console.log(probe[0]);
  }

  console.log('\n--- KAST users only: Gauntlet TVL at latest snapshot ---');
  const [tvl] = (await sql`
    SELECT
      gs.snapshot_date::text AS snapshot_date,
      COUNT(*)::int AS holders,
      SUM(gs.usd_value)::text AS total_usd,
      MAX(gs.share_price)::text AS share_price
    FROM gauntlet_snapshots gs
    INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
    WHERE gs.snapshot_date = (SELECT MAX(snapshot_date) FROM gauntlet_snapshots)
    GROUP BY gs.snapshot_date
  `) as Array<Record<string, unknown>>;
  console.log(tvl);

  console.log('\n--- Coverage vs total Gauntlet holders (latest day) ---');
  const [cov] = (await sql`
    SELECT
      total.cnt AS total_holders,
      kast.cnt  AS kast_holders,
      total.tvl AS total_tvl,
      kast.tvl  AS kast_tvl
    FROM
      (SELECT COUNT(*)::int AS cnt, SUM(usd_value)::numeric AS tvl
       FROM gauntlet_snapshots
       WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM gauntlet_snapshots)) total,
      (SELECT COUNT(*)::int AS cnt, SUM(gs.usd_value)::numeric AS tvl
       FROM gauntlet_snapshots gs
       INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
       WHERE gs.snapshot_date = (SELECT MAX(snapshot_date) FROM gauntlet_snapshots)) kast
  `) as Array<Record<string, unknown>>;
  console.log(cov);

  console.log('\n--- recent dune_jobs ---');
  const jobs = (await sql`
    SELECT id, job_kind, status, started_at, completed_at, rows_count, error_message
    FROM dune_jobs ORDER BY id DESC LIMIT 6
  `) as Array<Record<string, unknown>>;
  for (const j of jobs) console.log(j);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
