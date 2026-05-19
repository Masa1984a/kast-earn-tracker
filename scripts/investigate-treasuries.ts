import { exit } from 'node:process';
import { getDb } from '../lib/db';

async function main(): Promise<void> {
  const db = getDb({ unpooled: true });

  // 1. 全 mint 受信ウォレット (おそらく treasury 系)
  console.log('=== All mint recipients (owners with kind=mint rows) ===');
  const minters = (await db`
    SELECT
      owner,
      COUNT(*)::int AS mint_txs,
      (SUM(delta::numeric) / 1e6)::float AS total_minted_usdky
    FROM usdky_tx_log
    WHERE kind = 'mint'
    GROUP BY owner
    ORDER BY total_minted_usdky DESC
  `) as Array<{ owner: string; mint_txs: number; total_minted_usdky: number }>;
  for (const r of minters) {
    console.log(
      `  ${r.owner}: ${r.mint_txs} mints, +${r.total_minted_usdky.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDKY`,
    );
  }

  // 2. Top 10 ホルダーの tx パターン (mint/burn/transfer 内訳)
  console.log('\n=== Top 10 current holders: tx pattern ===');
  const tops = (await db`
    SELECT owner, usd_value::float AS usd
    FROM usdky_snapshots
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM usdky_snapshots)
    ORDER BY usd_value DESC
    LIMIT 10
  `) as Array<{ owner: string; usd: number }>;

  for (const top of tops) {
    const pattern = (await db`
      SELECT kind,
             COUNT(*)::int AS n,
             (SUM(delta::numeric) / 1e6)::float AS net_usdky
      FROM usdky_tx_log
      WHERE owner = ${top.owner}
      GROUP BY kind
      ORDER BY kind
    `) as Array<{ kind: string; n: number; net_usdky: number }>;
    const parts = pattern.map(
      (p) => `${p.kind}=${p.n}tx ${p.net_usdky >= 0 ? '+' : ''}${p.net_usdky.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
    );
    console.log(`  ${top.owner.slice(0, 12)}... ($${Math.round(top.usd).toLocaleString()}): ${parts.join(' | ')}`);
  }

  // 3. 「Treasury 的」候補: mint を受けて転送で抜けて現在ほぼゼロ
  console.log('\n=== "Treasury-like" candidates (received mints, near-zero now) ===');
  const treasuryLike = (await db`
    WITH agg AS (
      SELECT
        owner,
        SUM(CASE WHEN kind = 'mint' THEN delta::numeric ELSE 0 END) AS minted,
        SUM(delta::numeric) AS net
      FROM usdky_tx_log
      GROUP BY owner
    )
    SELECT
      owner,
      (minted / 1e6)::float AS minted_usdky,
      (net / 1e6)::float    AS net_usdky
    FROM agg
    WHERE minted > 0
    ORDER BY minted DESC
  `) as Array<{ owner: string; minted_usdky: number; net_usdky: number }>;
  for (const r of treasuryLike) {
    const tag =
      Math.abs(r.net_usdky) / Math.max(r.minted_usdky, 1) < 0.01
        ? ' ← treasury-like (mints flow through)'
        : '';
    console.log(
      `  ${r.owner.slice(0, 12)}...: minted ${r.minted_usdky.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDKY, net ${r.net_usdky.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDKY${tag}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
