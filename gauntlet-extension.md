# KAST Earn Tracker - Gauntlet Alpha Vault 拡張仕様（非同期ジョブ + share_price対応版）

このファイルは既存の `usdky-tracker-spec.md` と `plan.md` への追加分です。
セクションごとに「どこに追記するか」を明示しています。

---

## 1. 拡張の背景

KAST Earnは複数の運用サービスを提供している:

- **USDKY** (既実装): KAST発行のScaledUI型ステーブルコイン、Solana
- **Gauntlet Alpha Vault** (本拡張): Aera Finance MultiDepositorVault、Base
  - Vault tokenの正体は **gtUSDa** (Gauntlet USD Alpha)
  - 内部運用はMorpho経由のステーブルコイン貸出
  - 利回り蓄積によってshare_priceが上昇する設計 (ERC-4626に類似)

両方を1つのダッシュボードに統合し、「KAST Earn全体のTVL分布」を時系列で見られるようにする。

### 主な変更点
1. 積み上げ棒グラフのデフォルト分解軸を「サービス別」に変更
2. サービスフィルタを追加（USDKY / Gauntlet Alpha Vault）
3. ヘッダ統計をサービスごとに分けて表示
4. 「Has SOL」フィルタを USDKY 専用と明示
5. **Dune APIアクセスを非同期ジョブパターンで実装**（Vercel関数timeout回避）
6. **share_price (NAV/share) をDuneから別queryで取得**し、USD換算の精度を担保する

---

## 2. データソース

Duneに **2つのquery** を作成済み:

### Query A: ホルダー別shares snapshot (既存)

| 項目 | 値 |
|------|------|
| Token contract | `0x000000000001CdB57E58Fa75Fe420a0f4D6640D5` (gtUSDa) |
| Chain | Base |
| **Dune query ID** | **`7534621`** |
| Returns | `snapshot_date`, `holder_address`, `gtusda_balance` (shares) |
| Params | `start_date`, `end_date`, `token` |
| ソース | `tokens_base.transfers` を集積し日次残高化 |

### Query B: 日次 share_price (新規)

| 項目 | 値 |
|------|------|
| **Dune query ID** | **`7543001`** |
| Returns | `effective_date`, `share_price`, `enter_events_today`, `daily_volume_usdc` |
| Params | `start_date`, `end_date`, `vault` |
| ソース | `base.logs` の `Enter` event を decode (`Enter(address,address,address,uint256,uint256)`, topic0 = `0x59009eaf55f74c19a447f53174708d6c3b16e27d0dd94f6a2a8845f6728b1614`) |
| 計算式 | share_price = SUM(USDC_deposited) / SUM(shares_minted) を日次volume-weighted で集計 |
| 補完 | depositがない日は前日値を forward-fill |

**確認済の事実 (Phase 9.1完了済)**:
- gtUSDa balance は **shares** (USD換算ではない)
- 2026-05-20時点で share_price ≈ **1.0665**
- 2025-06-05 (vault launch) から線形的に上昇 ≈ **年率 7.0%相当**
- 入力tokenはUSDCのみと仮定 (USDC token = `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`)

---

## 3. アーキテクチャ概要（非同期ジョブパターン）

Dune APIは `execute → poll → results` の流れで結果取得まで2〜5分かかる場合がある。Vercel関数timeout（Pro: 300秒）に近づくため、**ジョブテーブルを介した非同期パターン**を採用する。

```
                              dune-kickoff cron (日次)
                              ┌──────┴──────┐
                              ▼             ▼
                     job_kind=             job_kind=
                  gauntlet_daily       gauntlet_price
                  (Query 7534621)      (Query 7543001)
                              │             │
                              └──────┬──────┘
                                     ▼
                              ┌────────────┐
                              │ dune_jobs  │ ← dune-poll cron
                              │  (Neon)    │   (10min毎)
                              └─────┬──────┘
                                    │
                              ┌─────▼─────┐
                              │ Dune API  │
                              └─────┬─────┘
                                    │
                  ┌─────────────────┴────────────────┐
                  ▼                                  ▼
       gauntlet_snapshots                gauntlet_share_prices
       (holder, shares)                  (date, share_price)
                  │                                  │
                  └──────────────┬───────────────────┘
                                 ▼
                  価格反映 (auto-recompute trigger)
                  gauntlet_snapshots.usd_value を更新
```

**Cron A: dune-kickoff** (日次)
- snapshot query (7534621) と price query (7543001) を**両方とも** execute
- それぞれ別の job_kind で `dune_jobs` に起票
- 数秒で完了

**Cron B: dune-poll** (10分ごと)
- `dune_jobs` から `status='executing'` のジョブを取得
- 各ジョブのDune status確認
- 完了していれば結果取得 → `job_kind` に応じたテーブルにupsert
- snapshot ingest後、または price ingest後、`gauntlet_snapshots.usd_value` を auto-recompute

### この設計の利点
- Vercel関数timeout（Hobby 60s / Pro 300s）制約を完全に回避
- リトライが自然（pollが落ちても次の10分で続きから）
- 監査ログがジョブテーブル自体に残る
- snapshot と price で query を分離 → 一方が失敗しても他方は影響受けない
- バックフィルも同じ仕組みを流用可能（`job_kind` で区別）
- 将来 HYPE staking, SOL DCA等の追加分析にも転用可能

---

## 4. usdky-tracker-spec.md への追加セクション

> **追記位置**: 既存仕様書の「Phase 8: 動作確認」の後、「6. 既知の論点」の前

### Phase 9: Gauntlet Alpha Vault 統合

#### Step 9-0: 進行管理ファイルの更新
- [ ] `plan.md` に Phase 9 タスクを追記

#### Step 9-1: 仕様の事前検証 — **完了済**

確定事項:
- ✅ gtUSDa の `balance` は **shares**（USD換算ではない）
- ✅ Vault種別: Aera Finance MultiDepositorVault（ERC-4626類似だが独自event）
- ✅ Vaultローンチ日: **2025-06-05**
- ✅ share_price 取得方針: **Option C採用** (Dune queryで `Enter` event を decode)
- ✅ 入力token: USDC (`0x833589...02913`) と仮定
- ✅ Decimals: gtUSDa=18, USDC=6
- ✅ 現在 (2026-05-20) の share_price ≈ 1.0665, 年率換算 ≈ 7.0%

#### Step 9-2: Neonスキーマ追加

```sql
-- 非同期ジョブの状態管理テーブル
CREATE TABLE dune_jobs (
  id              serial      PRIMARY KEY,
  query_id        int         NOT NULL,
  params          jsonb       NOT NULL,
  execution_id    text,
  status          text        NOT NULL,         -- 'queued' | 'executing' | 'completed' | 'failed'
  rows_count      int,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  job_kind        text        NOT NULL
  -- job_kind: 'gauntlet_daily' | 'gauntlet_backfill' | 'gauntlet_price' | 'gauntlet_price_backfill'
);

CREATE INDEX idx_dune_jobs_active 
  ON dune_jobs (status, started_at) 
  WHERE status IN ('queued', 'executing');

CREATE INDEX idx_dune_jobs_kind_date 
  ON dune_jobs (job_kind, created_at DESC);

-- Gauntlet Alpha Vault 日次snapshot (shares = principal、usd_value は share_price 反映後の値)
CREATE TABLE gauntlet_snapshots (
  snapshot_date date    NOT NULL,
  holder        text    NOT NULL,
  shares        numeric NOT NULL,
  share_price   numeric NOT NULL DEFAULT 1.0,   -- 反映待ちなら 1.0
  usd_value     numeric NOT NULL,               -- shares × share_price
  chain         text    NOT NULL DEFAULT 'base',
  PRIMARY KEY (snapshot_date, holder)
);
CREATE INDEX idx_gauntlet_date ON gauntlet_snapshots (snapshot_date);
CREATE INDEX idx_gauntlet_holder ON gauntlet_snapshots (holder);

-- 日次 share_price 履歴
CREATE TABLE gauntlet_share_prices (
  effective_date     date     PRIMARY KEY,
  share_price        numeric  NOT NULL,
  enter_events_today int      NOT NULL DEFAULT 0,
  daily_volume_usdc  numeric  NOT NULL DEFAULT 0,
  source             text     NOT NULL DEFAULT 'dune_enter_event'
);
```

**設計方針**:
- `shares` は canonical truth (絶対書き換えない)
- `share_price` と `usd_value` は cache (auto-recompute対象)
- share_price job 完了時に、対象日の `gauntlet_snapshots` を一括UPDATE
- price がまだ揃ってない日は `share_price = 1.0` で graceful degradation

#### Step 9-3: Dune APIクライアント

`lib/dune.ts`:

```typescript
const DUNE_API = 'https://api.dune.com/api/v1';

// Query IDの定数
export const GAUNTLET_SNAPSHOTS_QUERY_ID = 7534621;
export const GAUNTLET_PRICE_QUERY_ID     = 7543001;

const headers = () => ({
  'X-Dune-API-Key': process.env.DUNE_API_KEY!,
  'Content-Type': 'application/json',
});

export async function executeQuery(
  queryId: number,
  params: Record<string, string>
): Promise<string> {
  const res = await fetch(`${DUNE_API}/query/${queryId}/execute`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query_parameters: params }),
  });
  if (!res.ok) throw new Error(`Dune execute failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.execution_id;
}

export type DuneExecutionState =
  | 'QUERY_STATE_PENDING'
  | 'QUERY_STATE_EXECUTING'
  | 'QUERY_STATE_COMPLETED'
  | 'QUERY_STATE_FAILED'
  | 'QUERY_STATE_CANCELLED';

export async function getExecutionStatus(executionId: string): Promise<{
  state: DuneExecutionState;
  raw: any;
}> {
  const res = await fetch(`${DUNE_API}/execution/${executionId}/status`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`Dune status failed: ${res.status}`);
  const j = await res.json();
  return { state: j.state, raw: j };
}

export async function getExecutionResults(executionId: string): Promise<any[]> {
  const res = await fetch(`${DUNE_API}/execution/${executionId}/results`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`Dune results failed: ${res.status}`);
  const j = await res.json();
  return j.result.rows;
}
```

#### Step 9-4: ジョブ取り込みロジック

`lib/ingest.ts`:

```typescript
import { neon } from '@neondatabase/serverless';

type Sql = ReturnType<typeof neon>;

export async function ingestJobResults(
  sql: Sql,
  jobKind: string,
  rows: any[]
): Promise<{ inserted: number }> {
  if (jobKind === 'gauntlet_daily' || jobKind === 'gauntlet_backfill') {
    return ingestGauntletSnapshots(sql, rows);
  }
  if (jobKind === 'gauntlet_price' || jobKind === 'gauntlet_price_backfill') {
    return ingestGauntletPrices(sql, rows);
  }
  throw new Error(`Unknown job_kind: ${jobKind}`);
}

// --- snapshot 取り込み ---
async function ingestGauntletSnapshots(
  sql: Sql,
  rows: any[]
): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };

  const BATCH = 500;
  let total = 0;

  // 各snapshot_dateごとの share_price を事前に取得 (反映できればする、無ければ1.0)
  const uniqueDates = [...new Set(rows.map(r => r.snapshot_date.slice(0, 10)))];
  const priceRows = await sql`
    SELECT effective_date, share_price 
    FROM gauntlet_share_prices 
    WHERE effective_date = ANY(${uniqueDates}::date[])
  `;
  const priceMap = new Map<string, number>(
    priceRows.map((r: any) => [r.effective_date.toISOString().slice(0, 10), Number(r.share_price)])
  );

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const dates = batch.map(r => r.snapshot_date.slice(0, 10));
    const holders = batch.map(r => r.holder_address);
    const shares = batch.map(r => Number(r.gtusda_balance));
    const prices = dates.map(d => priceMap.get(d) ?? 1.0);
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

// --- share_price 取り込み + snapshots auto-recompute ---
async function ingestGauntletPrices(
  sql: Sql,
  rows: any[]
): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };

  // 1. share_prices テーブルに upsert
  const dates = rows.map(r => r.effective_date.slice(0, 10));
  const prices = rows.map(r => Number(r.share_price));
  const eventCounts = rows.map(r => Number(r.enter_events_today ?? 0));
  const volumes = rows.map(r => Number(r.daily_volume_usdc ?? 0));

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

  // 2. auto-recompute: 対象日の gauntlet_snapshots.usd_value を更新
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
```

**設計のポイント**:
- snapshot ingest時にprice tableを先読みして反映
- price ingest時にsnapshot tableを後から書き換える
- 「snapshot先・price後」「price先・snapshot後」どちらの順序でも最終的に整合する (eventual consistency)
- 冪等性: 同じデータを何度ingestしても結果は同じ

#### Step 9-5: Cron A — dune-kickoff（日次・両query起票）

`app/api/cron/dune-kickoff/route.ts`:

```typescript
import { neon } from '@neondatabase/serverless';
import {
  executeQuery,
  GAUNTLET_SNAPSHOTS_QUERY_ID,
  GAUNTLET_PRICE_QUERY_ID,
} from '@/lib/dune';

export const maxDuration = 30;

const GTUSDA = '0x000000000001CdB57E58Fa75Fe420a0f4D6640D5';

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const sql = neon(process.env.DATABASE_URL!);
  const end_date = new Date().toISOString().slice(0, 10);
  const start_date = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);

  // 並列で2つのjob起票
  const jobs = await Promise.all([
    kickoffJob(sql, {
      query_id: GAUNTLET_SNAPSHOTS_QUERY_ID,
      job_kind: 'gauntlet_daily',
      params: { start_date, end_date, token: GTUSDA },
    }),
    kickoffJob(sql, {
      query_id: GAUNTLET_PRICE_QUERY_ID,
      job_kind: 'gauntlet_price',
      params: { start_date, end_date, vault: GTUSDA },
    }),
  ]);

  return Response.json({ jobs });
}

async function kickoffJob(sql: any, opts: {
  query_id: number;
  job_kind: string;
  params: Record<string, string>;
}): Promise<any> {
  // 当日重複チェック
  const [existing] = await sql`
    SELECT id, status FROM dune_jobs
    WHERE job_kind = ${opts.job_kind}
      AND created_at::date = current_date
      AND status IN ('executing', 'completed')
    LIMIT 1
  `;
  if (existing) {
    return { skipped: true, job_kind: opts.job_kind, existing };
  }

  const execution_id = await executeQuery(opts.query_id, opts.params);
  const [job] = await sql`
    INSERT INTO dune_jobs (query_id, params, execution_id, status, job_kind, started_at)
    VALUES (
      ${opts.query_id},
      ${JSON.stringify(opts.params)},
      ${execution_id},
      'executing',
      ${opts.job_kind},
      now()
    )
    RETURNING id
  `;
  return { job_kind: opts.job_kind, job_id: job.id, execution_id };
}
```

#### Step 9-6: Cron B — dune-poll（変更なし）

`app/api/cron/dune-poll/route.ts` の構造は変えない。`job_kind` ベースのdispatcherで `gauntlet_price` も自動で取り込まれる。

```typescript
import { neon } from '@neondatabase/serverless';
import { getExecutionStatus, getExecutionResults } from '@/lib/dune';
import { ingestJobResults } from '@/lib/ingest';

export const maxDuration = 60;
const STALE_HOURS = 1;

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const sql = neon(process.env.DATABASE_URL!);

  // Stale掃除
  await sql`
    UPDATE dune_jobs
    SET status = 'failed',
        completed_at = now(),
        error_message = 'Stale: exceeded ' || ${STALE_HOURS} || ' hours'
    WHERE status = 'executing'
      AND started_at < now() - interval '1 hour' * ${STALE_HOURS}
  `;

  const jobs = await sql`
    SELECT id, execution_id, job_kind
    FROM dune_jobs
    WHERE status = 'executing'
    ORDER BY started_at ASC
    LIMIT 5
  `;

  if (jobs.length === 0) {
    return Response.json({ polled: 0, note: 'no executing jobs' });
  }

  const results = [];
  for (const job of jobs) {
    try {
      const { state } = await getExecutionStatus(job.execution_id);

      if (state === 'QUERY_STATE_COMPLETED') {
        const rows = await getExecutionResults(job.execution_id);
        const { inserted } = await ingestJobResults(sql, job.job_kind, rows);
        await sql`
          UPDATE dune_jobs
          SET status = 'completed', completed_at = now(), rows_count = ${inserted}
          WHERE id = ${job.id}
        `;
        results.push({ job_id: job.id, job_kind: job.job_kind, status: 'completed', rows: inserted });
      } else if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') {
        await sql`
          UPDATE dune_jobs
          SET status = 'failed', completed_at = now(), error_message = ${state}
          WHERE id = ${job.id}
        `;
        results.push({ job_id: job.id, job_kind: job.job_kind, status: 'failed', state });
      } else {
        results.push({ job_id: job.id, job_kind: job.job_kind, status: 'still_executing', state });
      }
    } catch (err: any) {
      results.push({ job_id: job.id, status: 'poll_error', error: err.message });
    }
  }

  return Response.json({ polled: jobs.length, results });
}
```

#### Step 9-7: バックフィル admin endpoint

snapshot と price の両方を1リクエストで起動できるように:

`app/api/admin/trigger-gauntlet-backfill/route.ts`:

```typescript
import { neon } from '@neondatabase/serverless';
import {
  executeQuery,
  GAUNTLET_SNAPSHOTS_QUERY_ID,
  GAUNTLET_PRICE_QUERY_ID,
} from '@/lib/dune';

export const maxDuration = 30;

const GTUSDA = '0x000000000001CdB57E58Fa75Fe420a0f4D6640D5';

export async function POST(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { start_date, end_date, kinds } = await request.json();
  if (!start_date || !end_date) {
    return new Response('Missing start_date or end_date', { status: 400 });
  }

  // kinds 未指定なら両方
  const targets = kinds ?? ['snapshots', 'price'];
  const sql = neon(process.env.DATABASE_URL!);
  const jobs: any[] = [];

  if (targets.includes('snapshots')) {
    const params = { start_date, end_date, token: GTUSDA };
    const execution_id = await executeQuery(GAUNTLET_SNAPSHOTS_QUERY_ID, params);
    const [job] = await sql`
      INSERT INTO dune_jobs (query_id, params, execution_id, status, job_kind, started_at)
      VALUES (${GAUNTLET_SNAPSHOTS_QUERY_ID}, ${JSON.stringify(params)}, ${execution_id}, 'executing', 'gauntlet_backfill', now())
      RETURNING id
    `;
    jobs.push({ kind: 'gauntlet_backfill', job_id: job.id, execution_id });
  }

  if (targets.includes('price')) {
    const params = { start_date, end_date, vault: GTUSDA };
    const execution_id = await executeQuery(GAUNTLET_PRICE_QUERY_ID, params);
    const [job] = await sql`
      INSERT INTO dune_jobs (query_id, params, execution_id, status, job_kind, started_at)
      VALUES (${GAUNTLET_PRICE_QUERY_ID}, ${JSON.stringify(params)}, ${execution_id}, 'executing', 'gauntlet_price_backfill', now())
      RETURNING id
    `;
    jobs.push({ kind: 'gauntlet_price_backfill', job_id: job.id, execution_id });
  }

  return Response.json({
    jobs,
    note: 'Jobs queued. dune-poll cron will pick them up within 10 minutes.',
  });
}
```

起動方法:

```bash
# 両方ともバックフィル (推奨)
curl -X POST https://YOUR_DOMAIN.vercel.app/api/admin/trigger-gauntlet-backfill \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"start_date":"2025-06-05","end_date":"2026-05-20"}'

# priceだけ再取得 (snapshotを残したまま価格だけ最新化したい時)
curl -X POST https://YOUR_DOMAIN.vercel.app/api/admin/trigger-gauntlet-backfill \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"start_date":"2025-06-05","end_date":"2026-05-20","kinds":["price"]}'
```

進捗追跡:

```sql
SELECT id, job_kind, status, started_at, completed_at, rows_count, error_message
FROM dune_jobs
WHERE job_kind LIKE 'gauntlet%'
ORDER BY id DESC LIMIT 10;
```

#### Step 9-8: vercel.json 更新

```json
{
  "crons": [
    { "path": "/api/cron/usdky-snapshot", "schedule": "5 0 * * *" },
    { "path": "/api/cron/dune-kickoff",   "schedule": "20 0 * * *" },
    { "path": "/api/cron/dune-poll",      "schedule": "*/10 * * * *" }
  ]
}
```

(変更なし — kickoffで2つのqueryを内部的に起票する)

#### Step 9-9: API エンドポイント拡張

`app/api/snapshots/route.ts` に `service` パラメータを追加:

| パラメータ | 値 | 挙動 |
|--------|-----|------|
| `service` 未指定 | - | サービス別集計（USDKY合計 / Gauntlet合計）|
| `service=usdky` | - | USDKYのみ、ボリュームバケットで集計 |
| `service=gauntlet` | - | Gauntletのみ、ボリュームバケットで集計 |
| `has_sol=false` | usdkyのみ有効 | SOL保有ウォレットを除外 |

`gauntlet_snapshots.usd_value` は ingest 時に auto-recompute されるので、APIクエリでJOINは不要 (高速):

```sql
SELECT snapshot_date, 'usdky' AS service, SUM(usd_value) AS usd_value
FROM usdky_snapshots
GROUP BY 1
UNION ALL
SELECT snapshot_date, 'gauntlet' AS service, SUM(usd_value)
FROM gauntlet_snapshots
GROUP BY 1
ORDER BY 1, 2;
```

#### Step 9-10: フロントエンド改修

##### サービスフィルタ
```
┌──────────────────────────────────────┐
│ [ All ] [ USDKY ] [ Gauntlet Alpha ]  │
└──────────────────────────────────────┘
```
- `All`: stackId = service
- 個別選択: stackId = volume bucket

##### ヘッダ統計をサービスごとに分割

```
┌─────────────────────┬──────────────────────────┐
│ USDKY                │ Gauntlet Alpha           │
│  snapshot: 2026-05-19│  snapshot: 2026-05-19    │
│  holders:   1,089    │  holders:    234         │
│  total USD: $7.4M    │  total USD: $1.2M        │
│  multiplier: 1.0316  │  share price: 1.0665     │
│   (~3% / yr)         │   (~7% / yr est.)        │
└─────────────────────┴──────────────────────────┘
```

annualized yield は、過去30日のshare_price変化から推定する形でクライアント側計算:

```typescript
// 過去30日間のshare_price推移から年率算出
const days = 30;
const recent = sharePrices.slice(-days);
const startPrice = recent[0].share_price;
const endPrice = recent[recent.length - 1].share_price;
const annualized = Math.pow(endPrice / startPrice, 365 / days) - 1;
// e.g. 0.07 = 7%
```

モバイル時は縦並び。

##### "Has SOL" フィルタ
USDKYブロック内に配置 + ラベル明示。Gauntlet選択時は非表示。

#### Step 9-11: 動作確認

- [ ] スキーマmigration適用後、`dune_jobs` / `gauntlet_snapshots` / `gauntlet_share_prices` の3テーブルがNeonに存在
- [ ] バックフィル実行 (`POST /api/admin/trigger-gauntlet-backfill` で snapshot + price 両方)
- [ ] `dune_jobs` で2ジョブのステータス遷移確認 (`executing → completed`)
- [ ] `gauntlet_snapshots.usd_value` が `shares × share_price` で正しく入っているか抽出確認
- [ ] サービスフィルタ切り替え動作確認
- [ ] 自分のBase walletの保有額 (`0x37100...02cae`) がKASTアプリ表示 ($1.01) と一致
- [ ] dune-kickoff cron 翌日自動実行 → poll cronが10分以内に両jobsを取り込み
- [ ] わざと price job だけ失敗させ → snapshot は入るが share_price=1.0 で degradation 動作確認
- [ ] その後 price のみバックフィル → usd_value が auto-recompute されることを確認

---

## 5. plan.md への追加タスク

> **追記位置**: 既存 `plan.md` の Phase 8 末尾の後に Phase 9 として追加

```markdown
---

## Phase 9: Gauntlet Alpha Vault 統合（非同期ジョブ + share_price 対応版）

### 9.0 進行管理
- [ ] **9.0** plan.md にPhase 9を追記済み — `In Progress`

### 9.1 事前検証 — **完了済**
- [x] **9.1.1** gtusda_balance = shares と確定 — `Done`
- [x] **9.1.2** MultiDepositorVault (Aera Finance) と確定 — `Done`
- [x] **9.1.3** ローンチ日 2025-06-05 と確定 — `Done`
- [x] **9.1.4** Option C採用 (Dune share_price query) — `Done` (query ID 7543001)

### 9.2 スキーマ追加
- [ ] **9.2.1** `dune_jobs` テーブル + 部分インデックス作成のmigration — `Pending`
- [ ] **9.2.2** `gauntlet_snapshots` テーブル作成のmigration — `Pending`
- [ ] **9.2.3** `gauntlet_share_prices` テーブル作成のmigration — `Pending`
- [ ] **9.2.4** Neonに適用 — `Pending`

### 9.3 Dune APIクライアント
- [ ] **9.3.1** `lib/dune.ts` 作成 — `Pending`
- [ ] **9.3.2** `executeQuery` / `getExecutionStatus` / `getExecutionResults` 実装 — `Pending`
- [ ] **9.3.3** query ID 定数 (7534621 / 7543001) 定義 — `Pending`
- [ ] **9.3.4** `DUNE_API_KEY` をlocal & Vercel環境変数に追加 — `Pending`

### 9.4 ジョブ取り込みロジック
- [ ] **9.4.1** `lib/ingest.ts` 作成 — `Pending`
- [ ] **9.4.2** `ingestJobResults` ディスパッチャ実装 — `Pending`
- [ ] **9.4.3** `ingestGauntletSnapshots` 実装 (price先読み + usd_value計算) — `Pending`
- [ ] **9.4.4** `ingestGauntletPrices` 実装 (share_price upsert) — `Pending`
- [ ] **9.4.5** auto-recompute logic 実装 (price ingest後の snapshots UPDATE) — `Pending`

### 9.5 Cron A: dune-kickoff
- [ ] **9.5.1** `app/api/cron/dune-kickoff/route.ts` 作成 — `Pending`
- [ ] **9.5.2** snapshot job kickoff 実装 — `Pending`
- [ ] **9.5.3** price job kickoff 実装 — `Pending`
- [ ] **9.5.4** 冪等性チェック (job_kindごとの当日重複防止) — `Pending`
- [ ] **9.5.5** 手動curl疎通確認 — `Pending`

### 9.6 Cron B: dune-poll
- [ ] **9.6.1** `app/api/cron/dune-poll/route.ts` 作成 — `Pending`
- [ ] **9.6.2** Stale掃除ロジック — `Pending`
- [ ] **9.6.3** snapshot job のステータス遷移確認 — `Pending`
- [ ] **9.6.4** price job のステータス遷移確認 — `Pending`
- [ ] **9.6.5** auto-recompute が走ることを確認 — `Pending`

### 9.7 バックフィル admin endpoint
- [ ] **9.7.1** `app/api/admin/trigger-gauntlet-backfill/route.ts` 作成 — `Pending`
- [ ] **9.7.2** `kinds` パラメータで snapshot / price を個別 or 一括起動可能に — `Pending`
- [ ] **9.7.3** ローカルから snapshot + price 一括バックフィル発動 — `Pending`
- [ ] **9.7.4** `dune_jobs` / `gauntlet_snapshots` / `gauntlet_share_prices` 全てに値が入ることを確認 — `Pending`

### 9.8 vercel.json 更新
- [ ] **9.8.1** kickoff + poll 2つのcron追加 — `Pending`

### 9.9 APIエンドポイント拡張
- [ ] **9.9.1** `/api/snapshots` に `service` パラメータ追加 — `Pending`
- [ ] **9.9.2** デフォルト (全サービス) レスポンス実装 — `Pending`
- [ ] **9.9.3** サービス指定時のbucketロジック維持確認 — `Pending`
- [ ] **9.9.4** share_price履歴を返すサブエンドポイント `/api/share-prices?service=gauntlet` 追加 — `Pending`

### 9.10 フロントエンド改修
- [ ] **9.10.1** サービスフィルタUI追加 (All / USDKY / Gauntlet) — `Pending`
- [ ] **9.10.2** ヘッダ統計サービス別分割表示 — `Pending`
- [ ] **9.10.3** Gauntletヘッダに share_price + annualized yield 表示 — `Pending`
- [ ] **9.10.4** 「Has SOL」フィルタをUSDKYブロックに移動 + 条件表示 — `Pending`
- [ ] **9.10.5** 積み上げグラフのstackId切り替えロジック — `Pending`
- [ ] **9.10.6** モバイルレスポンシブ確認 — `Pending`

### 9.11 動作確認 + 本番デプロイ
- [ ] **9.11.1** Gauntletバックフィル後の3テーブルレコード確認 — `Pending`
- [ ] **9.11.2** Cron翌日自動実行 + 両jobs取り込み確認 — `Pending`
- [ ] **9.11.3** masanoriさんのBase walletの保有額がKASTアプリ ($1.01) と一致 — `Pending`
- [ ] **9.11.4** Stale掃除ロジック動作確認 — `Pending`
- [ ] **9.11.5** price のみ再バックフィル → usd_value auto-recompute確認 — `Pending`
- [ ] **9.11.6** Production deploy + 全機能動作確認 — `Pending`
```

---

## 6. 環境変数の追加

`.env.local` と Vercel ダッシュボード両方に追加:

```bash
DUNE_API_KEY=...
```

---

## 7. 実装上の注意点

### Dune APIのレートリミット
日次kickoff 2回 (snapshot + price) + 10分pollで考慮した月間API call数:
- kickoff: 2/日 × 30日 = 60 calls
- poll status: 平均1〜2回/ジョブ × 60ジョブ/月 ≈ 120 calls
- poll results: 1/ジョブ × 60 = 60 calls
- **合計: 240 calls/月程度**

Dune Plusプランの月間execution枠 (数千件) 内に余裕で収まる。

### auto-recompute の順序依存
- snapshot 先 / price 後: snapshot ingest時はpriceがあれば反映、なければ1.0でinsert → price ingest時にUPDATE
- price 先 / snapshot 後: snapshot ingest時にpriceを先読みして反映
- どちらの順序でも最終結果は同じ (eventual consistency)
- ただし「snapshotだけ入ってpriceがまだ」のタイミングで dashboard を見ると、Gauntlet TVLが約7%低く表示される。これは数分〜数十分で解消する一時的状態

### Gauntlet側ホルダー分布の特性
USDKYと違い、Gauntlet Alpha VaultはKAST以外のホルダー (Morphoユーザー、外部DeFiユーザー) も保有している可能性が高い。Phase 9.11時にKASTアプリ上の数値と比較して、ズレが大きければ別途絞り込み戦略を検討する。Solana側「Has SOL」のような単純なヒューリスティクスはBaseでは使えないため、KAST関連のentry/exit経路でフィルタする戦略 (Phase 10候補) を検討。

### 入力tokenがUSDC以外の可能性
現状のshare_price queryは `topic3 = USDC` でフィルタしている。万一Gauntletが他のstablecoin (USDT, DAI等) も受け入れるようになった場合、その分のEnterイベントが計算から外れる。Query Bの`enter_events_today` が急に減ったら要調査。

### share_price の lumpy 動作 (将来の検討)
グラフ確認上は線形上昇に見えるが、より高解像度 (時間単位) で見ると、Enter eventが入った瞬間にステップ的に price が変動している可能性がある。日次集計では平準化されてsmoothに見える。
ユーザー個人視点での「自分が deposit/withdraw した瞬間のexact share_price」を見たいニーズが出てきたら、`gauntlet_share_prices` をdaily ではなく hourly or per-event 粒度に拡張する余地あり。

### ジョブテーブルの将来拡張
`dune_jobs` は現状Dune専用だが、命名を `external_jobs` に変えて `provider` カラムを足せば、他の外部非同期API (Helius webhook、Arbitrum indexer等) にも転用可能。
ただし**今は早期抽象化を避け**、必要になったタイミングでrenameする方が手堅い。

### `dune-poll` の並列処理上限
`LIMIT 5` にしているのは、Dune APIのrate limitとVercel関数timeoutの両方を考慮した安全値。バックフィルで snapshot + price の2ジョブが並列実行されても問題なし。