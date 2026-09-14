/**
 * `dune_jobs` に `executing` のまま滞留した行を後始末する。
 *
 * ingest が例外で落ちると `dune-poll` は `poll_error` を返すだけで job は `executing` のまま残る。
 * その状態を放置すると、次の poll 窓で 10 分おきに数万行の results を取得しては失敗する
 * ループになり、Dune の取得と Neon の起床を無駄に消費する（Phase 21）。
 *
 *   npx tsx --env-file=.env.local scripts/fix-stuck-dune-jobs.ts                  一覧するだけ
 *   npx tsx --env-file=.env.local scripts/fix-stuck-dune-jobs.ts --older-than 3 --yes
 */
import { argv, exit } from 'node:process';
import { getDb } from '../lib/db';

function parseArgs() {
  let olderThanHours = 3;
  let yes = false;
  let note = 'manually resolved: results were ingested by scripts/backfill-gauntlet-range.ts';
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--older-than') olderThanHours = Number(argv[++i]);
    else if (a === '--yes') yes = true;
    else if (a === '--note') note = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      exit(1);
    }
  }
  if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
    console.error(`invalid --older-than: ${olderThanHours}`);
    exit(1);
  }
  return { olderThanHours, yes, note };
}

async function main() {
  const { olderThanHours, yes, note } = parseArgs();
  const sql = getDb({ unpooled: true });

  const stuck = (await sql`
    SELECT id, job_kind, execution_id,
           started_at,
           ROUND(EXTRACT(EPOCH FROM (now() - started_at)) / 3600.0, 1)::text AS age_hours,
           params->>'start_date' AS start_date,
           params->>'end_date'   AS end_date
    FROM dune_jobs
    WHERE status = 'executing'
      AND started_at < now() - (interval '1 hour' * ${olderThanHours}::numeric)
    ORDER BY id
  `) as Array<Record<string, string>>;

  if (stuck.length === 0) {
    console.log(`${olderThanHours} 時間以上 executing のままの job は無い`);
    return;
  }

  console.log(`${olderThanHours} 時間以上 executing のままの job: ${stuck.length} 件`);
  for (const j of stuck) {
    console.log(
      `  #${j.id} ${j.job_kind} age=${j.age_hours}h exec=${j.execution_id ?? '-'}` +
        ` window=${j.start_date ?? '-'}..${j.end_date ?? '-'}`,
    );
  }

  if (!yes) {
    console.log('\n--yes が無いので何もしない（failed に落とすなら --yes）');
    console.log('※ execution_id は残るので、後から --execution-id で追加クレジットなしに取り込めます');
    return;
  }

  const ids = stuck.map((j) => Number(j.id));
  await sql`
    UPDATE dune_jobs
    SET status = 'failed', completed_at = now(), error_message = ${note}
    WHERE id = ANY(${ids}::int[]) AND status = 'executing'
  `;
  console.log(`\n${ids.length} 件を failed にした: ${ids.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
