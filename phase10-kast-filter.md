# KAST Earn Tracker - Phase 10: KAST Users Filter (Bybit OTC signature)

このファイルは既存の `usdky-tracker-spec.md` / `gauntlet-extension.md` / `plan.md` への追加分です。

---

## 1. 背景

Phase 9 で Gauntlet Alpha Vault を統合した後、masanoriさんが「KASTユーザーの実態を知りたい」という質問を起点に、以下を調査して確定:

### 調査で確定した事実

- **gtUSDa Alpha (KAST EarnのGauntlet部分) はMorpho Gauntlet USDC Prime に直接注入する feeder vault**
  - gtUSDa Alpha TVL: $66.7M のうち $66.66M を Morpho Gauntlet USDC Prime に allocation
  - Morpho側 vault 全体 $79.81M のうち、~83% が gtUSDa Alpha 経由
  - **gtUSDa Alpha は KAST 専用ではなく、Morpho の公開vault に対する retail UX layer**

- **Privy / ZeroDev Kernel signature では KAST users を識別不可**
  - masanoriさんの wallet は EIP-7702 で ZeroDev Kernel v3.3 (`0xd6CEDDe8...`) に委譲
  - Kernel はZeroDevの公式実装で、Privy / Polynomial / 他多数のサービスで汎用利用
  - 単体では KAST 識別不可

- **Bybit OTC funding が KAST signature として機能**
  - Bybit OTC アドレス: `0x5E690CFd5598F8d0E335b96e9F2f1b1527b7a5bF`
  - gtUSDa Alpha ホルダー 6,446人 のうち、**4,409人 (68.4%) が初回USDC受領元として Bybit OTC を経由**
  - Pie chart で見て他のfundersは数%以下、Bybit OTC が圧倒的に支配的
  - これは **USDKY における「Has SOL = false」filter と等価の、Base版KAST signature**

### Phase 10 のゴール

Phase 9 で実装済みの Gauntlet ダッシュボードに、**KAST users のみを表示するフィルタ**を追加する。USDKY 側の「Has SOL」フィルタと統合して、**「KAST users only」マスタートグル**として動作させる。

---

## 2. アーキテクチャ概要

### データフロー

```
                    dune-kickoff cron (日次)
                    ┌────────┴────────┐
                    ▼                 ▼          ▼ (既存)
              gauntlet_daily    gauntlet_price   kast_base_wallets (新)
              (Query 7534621)   (Query 7543001)  (Query TBD)
                    │                 │            │
                    └─────────────────┴────────────┘
                                      ▼
                              dune_jobs (Neon)
                                      │
                                      ▼ (dune-poll cron)
                          ┌──────────────────────┐
                          ▼                      ▼
                gauntlet_snapshots     kast_base_wallets (新table)
                                                 │
                                                 ▼
                                       API endpoint で
                                       kast_only=true 時に
                                       INNER JOIN
```

### ロジック

KAST users 識別は **on-chain で観察可能な「初回USDC funding 元」を signature** として使う:

| サービス | KAST signature | フィルタロジック |
|---|---|---|
| USDKY (Solana) | wallet が SOL を保有していない | EXCLUDE wallets with SOL balance > 0 |
| Gauntlet Alpha (Base) | 初回USDC受領元 = Bybit OTC (`0x5E690CFd...`) | INCLUDE only wallets in `kast_base_wallets` |

両 signature を統合した「**KAST users only**」マスタートグルを UI に追加。

---

## 3. Dune query (新規作成)

ホルダーの初回USDC受領元を判定し、KAST signature にマッチするwallet listを返す。

```sql
/*  KAST-funded gtUSDa Alpha holders
    
    各ホルダーへの初回USDC送金元が Bybit OTC (0x5E690CFd...) であれば
    KAST onboarding 経由と判定する。
    
    Parameters:
    - vault        (text) : 0x000000000001CdB57E58Fa75Fe420a0f4D6640D5
    - usdc         (text) : 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
    - kast_onramp  (text) : 0x5E690CFd5598F8d0E335b96e9F2f1b1527b7a5bF       */
WITH params AS (
    SELECT
        from_hex(REPLACE('{{vault}}', '0x', ''))        AS gtusda_addr,
        from_hex(REPLACE('{{usdc}}', '0x', ''))         AS usdc_addr,
        from_hex(REPLACE('{{kast_onramp}}', '0x', ''))  AS funding_wallet
),
/* gtUSDa Alpha ホルダー */
holders AS (
    SELECT DISTINCT "to" AS holder
    FROM tokens_base.transfers
    WHERE contract_address = (SELECT gtusda_addr FROM params)
),
/* 各ホルダーへの最初のUSDC流入 ($1以上、dust除外) */
first_funding AS (
    SELECT 
        t."to"     AS holder,
        t."from"   AS first_funder,
        t.block_time AS first_funding_time,
        ROW_NUMBER() OVER (PARTITION BY t."to" ORDER BY t.block_time ASC) AS rn
    FROM tokens_base.transfers t
    INNER JOIN holders h ON h.holder = t."to"
    WHERE t.contract_address = (SELECT usdc_addr FROM params)
      AND t.amount >= 1
)
/* KAST signature にマッチする wallet 一覧 */
SELECT 
    holder              AS wallet,
    first_funding_time  AS first_funded_at
FROM first_funding
WHERE rn = 1 
  AND first_funder = (SELECT funding_wallet FROM params)
ORDER BY first_funded_at DESC;
```

**期待される結果**: 約 4,409 行 (現時点)。

**確定済の query 情報**:
- **Dune query ID**: `7544316`
- デフォルトパラメータ:
  - `vault` = `0x000000000001CdB57E58Fa75Fe420a0f4D6640D5`
  - `usdc` = `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
  - `kast_onramp` = `0x5E690CFd5598F8d0E335b96e9F2f1b1527b7a5bF`

---

## 4. usdky-tracker-spec.md への追加セクション

> **追記位置**: Phase 9 の Step 9-11 の後に Phase 10 として追加

### Phase 10: KAST Users Filter (Bybit OTC signature)

#### Step 10-0: 進行管理ファイル更新
- [ ] `plan.md` に Phase 10 タスクを追記

#### Step 10-1: Dune query 作成 + ID確定 — **完了済**
- [x] §3 のqueryを Dune に新規作成
- [x] query ID 確定: **`7544316`**
- [ ] `lib/dune.ts` に定数として追加 (Step 10-3 で実施)

#### Step 10-2: Neonスキーマ追加

```sql
-- KAST-funded base wallets (Bybit OTC signature でマッチした wallet 一覧)
CREATE TABLE kast_base_wallets (
    wallet           text        PRIMARY KEY,
    first_funded_at  timestamptz NOT NULL,
    last_updated_at  timestamptz NOT NULL DEFAULT now(),
    source           text        NOT NULL DEFAULT 'bybit_otc_signature'
);
CREATE INDEX idx_kast_wallets_funded ON kast_base_wallets (first_funded_at);
```

設計方針:
- このテーブルは「最新のknown KASTユーザー一覧」を保持
- 新規KASTユーザーは日次cronで追加
- 既存wallet は更新せず、新規のみ insert (冪等)

#### Step 10-3: lib/dune.ts に query ID 追加

```typescript
// Query IDの定数
export const GAUNTLET_SNAPSHOTS_QUERY_ID = 7534621;
export const GAUNTLET_PRICE_QUERY_ID     = 7543001;
export const KAST_BASE_WALLETS_QUERY_ID  = 7544316;
```

#### Step 10-4: lib/ingest.ts に取り込みロジック追加

`ingestJobResults` のディスパッチャに新しい job_kind を追加:

```typescript
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
  // ← Phase 10 追加
  if (jobKind === 'kast_base_wallets_daily' || jobKind === 'kast_base_wallets_backfill') {
    return ingestKastBaseWallets(sql, rows);
  }
  throw new Error(`Unknown job_kind: ${jobKind}`);
}

async function ingestKastBaseWallets(
  sql: Sql,
  rows: any[]
): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };

  const BATCH = 500;
  let total = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const wallets = batch.map(r => r.wallet);
    const firstFundedAts = batch.map(r => r.first_funded_at);

    await sql`
      INSERT INTO kast_base_wallets (wallet, first_funded_at, last_updated_at)
      SELECT * FROM unnest(
        ${wallets}::text[],
        ${firstFundedAts}::timestamptz[],
        ${Array(batch.length).fill(new Date().toISOString())}::timestamptz[]
      )
      ON CONFLICT (wallet) DO UPDATE SET
        last_updated_at = excluded.last_updated_at
    `;
    total += batch.length;
  }

  return { inserted: total };
}
```

#### Step 10-5: dune-kickoff cron 更新

`app/api/cron/dune-kickoff/route.ts` に3つ目のjob起票を追加:

```typescript
const GTUSDA = '0x000000000001CdB57E58Fa75Fe420a0f4D6640D5';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const KAST_ONRAMP = '0x5E690CFd5598F8d0E335b96e9F2f1b1527b7a5bF';

// 並列で3つのjob起票
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
  // ← Phase 10 追加
  kickoffJob(sql, {
    query_id: KAST_BASE_WALLETS_QUERY_ID,
    job_kind: 'kast_base_wallets_daily',
    params: { vault: GTUSDA, usdc: USDC_BASE, kast_onramp: KAST_ONRAMP },
  }),
]);
```

#### Step 10-6: バックフィル admin endpoint 更新

`/api/admin/trigger-gauntlet-backfill` の `kinds` パラメータに `'kast_wallets'` を追加:

```typescript
const targets = kinds ?? ['snapshots', 'price', 'kast_wallets'];

if (targets.includes('kast_wallets')) {
  const params = { vault: GTUSDA, usdc: USDC_BASE, kast_onramp: KAST_ONRAMP };
  const execution_id = await executeQuery(KAST_BASE_WALLETS_QUERY_ID, params);
  const [job] = await sql`
    INSERT INTO dune_jobs (query_id, params, execution_id, status, job_kind, started_at)
    VALUES (${KAST_BASE_WALLETS_QUERY_ID}, ${JSON.stringify(params)}, ${execution_id}, 'executing', 'kast_base_wallets_backfill', now())
    RETURNING id
  `;
  jobs.push({ kind: 'kast_base_wallets_backfill', job_id: job.id, execution_id });
}
```

#### Step 10-7: API endpoint 拡張

`/api/snapshots` に `kast_only` パラメータを追加。

| パラメータ | 値 | 挙動 |
|--------|-----|------|
| `kast_only` 未指定 / false | デフォルト | 全ホルダーを集計 |
| `kast_only=true` | KAST users のみ | USDKY: Has SOL = false で除外。Gauntlet: kast_base_wallets と INNER JOIN |

##### USDKY 側 (既存のhas_solロジックを kast_only にも適用)

```sql
-- USDKY KAST users only
SELECT snapshot_date, SUM(usd_value)
FROM usdky_snapshots us
LEFT JOIN solana_sol_holders ssh ON ssh.owner = us.owner
WHERE ssh.owner IS NULL  -- SOLを持っていない
GROUP BY 1;
```

##### Gauntlet 側 (新規ロジック)

```sql
-- Gauntlet KAST users only
SELECT gs.snapshot_date, SUM(gs.usd_value)
FROM gauntlet_snapshots gs
INNER JOIN kast_base_wallets kbw ON kbw.wallet = gs.holder
GROUP BY 1;
```

##### サービス別の `service` パラメータ との組み合わせ

| service | kast_only | 集計対象 |
|---|---|---|
| 未指定 | false | 全サービス × 全ホルダー |
| 未指定 | true | 全サービス × KAST users |
| usdky | false | USDKY × 全ホルダー (volume bucket) |
| usdky | true | USDKY × KAST users (volume bucket) |
| gauntlet | false | Gauntlet × 全ホルダー (volume bucket) |
| gauntlet | true | Gauntlet × KAST users (volume bucket) |

#### Step 10-8: フロントエンド改修

##### 「Has SOL」トグルを「KAST users only」マスタートグルに変更

現状の UI:
```
[ All ] [ USDKY ] [ Gauntlet Alpha ]    ☑ Has SOL (USDKY: excluded - KAST users only)
```

変更後:
```
[ All ] [ USDKY ] [ Gauntlet Alpha ]    ☑ KAST users only
```

トグル ON 時、各サービスブロックに識別ロジックの注釈を表示:

```
USDKY                            Gauntlet Alpha
 snapshot: 2026-05-20             snapshot: 2026-05-20
 holders:   712                   holders:   4,409
 total USD: $580K                 total USD: $45M (est.)
 multiplier: 1.0319               share price: 1.0665
                                  annualized yield: 4.26%

 ※ Filtered: wallets without     ※ Filtered: wallets first funded
   SOL balance                      via Bybit OTC
```

##### 注釈ヘルパー

UIに小さな情報アイコンを追加し、ホバー時に「KAST users only」識別ロジックを説明:

> KAST users are identified by service-specific on-chain signatures:
> - USDKY (Solana): wallets without SOL balance (KAST sponsors gas, so KAST users typically don't hold SOL)
> - Gauntlet Alpha (Base): wallets whose first USDC funding came from KAST's Bybit OTC onramp wallet
>
> Coverage estimate: ~68% of Gauntlet holders, ~95% of USDKY holders.

#### Step 10-9: 動作確認

- [ ] バックフィル実行 (`POST /api/admin/trigger-gauntlet-backfill` で `kinds=['kast_wallets']`)
- [ ] `kast_base_wallets` に約 4,409 件のwalletが入ることを確認
- [ ] masanoriさんのwallet (`0x371002be73300a256cf9376e2f4a59ee00902cae`) が含まれることを確認
- [ ] API endpoint `/api/snapshots?service=gauntlet&kast_only=true` で TVLが ~$45M 前後 (推定) になることを確認
- [ ] UI トグル ON/OFF でグラフ・統計が変わることを確認
- [ ] dune-kickoff cron翌日自動実行 → kast_base_wallets が更新されることを確認

---

## 5. plan.md への追加タスク

> **追記位置**: Phase 9 の末尾の後に Phase 10 として追加

```markdown
---

## Phase 10: KAST Users Filter (Bybit OTC signature)

### 10.0 進行管理
- [ ] **10.0** plan.md にPhase 10を追記済み — `In Progress`

### 10.1 Dune query 作成 — **完了済**
- [x] **10.1.1** §3 のqueryを Dune に新規作成 — `Done` (query ID 7544316)
- [x] **10.1.2** デフォルトパラメータを設定 — `Done`
- [x] **10.1.3** 動作確認 (約4,409行返ることを期待) — `Done`
- [ ] **10.1.4** query IDを `lib/dune.ts` に追加 — `Pending` (Phase 10.3 で実施)

### 10.2 スキーマ追加
- [ ] **10.2.1** `kast_base_wallets` テーブル + インデックス作成のmigration — `Pending`
- [ ] **10.2.2** Neonに適用 — `Pending`

### 10.3 取り込みロジック追加
- [ ] **10.3.1** `lib/ingest.ts` の dispatcher に `kast_base_wallets_*` を追加 — `Pending`
- [ ] **10.3.2** `ingestKastBaseWallets` 実装 — `Pending`

### 10.4 Cron 更新
- [ ] **10.4.1** dune-kickoff cron に 3つ目の job (kast_base_wallets_daily) 追加 — `Pending`
- [ ] **10.4.2** 冪等性チェックを 3 job それぞれで実施 — `Pending`

### 10.5 バックフィル admin endpoint 更新
- [ ] **10.5.1** `kinds` パラメータに `kast_wallets` を追加 — `Pending`
- [ ] **10.5.2** ローカルから kast_wallets だけのバックフィルを実行 — `Pending`
- [ ] **10.5.3** `kast_base_wallets` に約 4,409 件が入ることを確認 — `Pending`

### 10.6 APIエンドポイント拡張
- [ ] **10.6.1** `/api/snapshots` に `kast_only` パラメータ追加 — `Pending`
- [ ] **10.6.2** USDKY 側のフィルタロジック (has_sol → kast_only に統合) — `Pending`
- [ ] **10.6.3** Gauntlet 側のフィルタロジック (kast_base_wallets と INNER JOIN) — `Pending`
- [ ] **10.6.4** service × kast_only の組み合わせ全6パターンの動作確認 — `Pending`

### 10.7 フロントエンド改修
- [ ] **10.7.1** 「Has SOL」トグルを「KAST users only」マスタートグルに変更 — `Pending`
- [ ] **10.7.2** トグル ON 時に各サービスブロックに識別ロジック注釈表示 — `Pending`
- [ ] **10.7.3** 情報アイコン + ホバー説明テキスト実装 — `Pending`
- [ ] **10.7.4** モバイルレスポンシブ確認 — `Pending`

### 10.8 動作確認 + 本番デプロイ
- [ ] **10.8.1** バックフィル後の `kast_base_wallets` レコード数確認 — `Pending`
- [ ] **10.8.2** masanoriさんのwalletが含まれることを確認 — `Pending`
- [ ] **10.8.3** Gauntlet KAST-only TVL が ~$45M 前後 (推定) になることを確認 — `Pending`
- [ ] **10.8.4** UI トグルで全サービス連動して切り替わることを確認 — `Pending`
- [ ] **10.8.5** Cron翌日自動実行確認 — `Pending`
- [ ] **10.8.6** Production deploy + 全機能動作確認 — `Pending`
```

---

## 6. 実装上の注意点

### 識別精度の限界

- **約 68% カバー率** (ホルダー数ベース) という事実をUIで明示する
- 残り 32% (約 2,037 ホルダー) は他経路 (CEX直接、Bridge、他DeFi入口) で来た可能性が高い
- これは「KAST users と完全に区別不能」というよりも、「KAST識別の保守的下限」として扱う

### TVLベース集計時の誤差

- ホルダー数では 68% でも、TVL では割合がずれる可能性
- KAST users は平均額が小さい (retail) ため、TVLベースでは 50-60% になる可能性
- これも事実として観察して、UI に表示する

### マイクロ更新の頻度

- 日次cronで `kast_base_wallets` を更新
- 新規KAST usersは毎日数件〜数十件追加される程度の想定
- 完全な再構築 (backfill) は月1回くらいで十分

### 将来の拡張性

- 万が一 KAST が onramp wallet を変更した場合、 `KAST_ONRAMP` 定数を更新するだけで対応可能
- 複数の onramp wallet が存在する場合は、Dune query の `WHERE first_funder IN (..., ..., ...)` で対応
- Bybit OTC 以外にも KAST が使っている onramp が発覚した場合、リストに追加すればよい

### masanoriさん流の運用ヒント

- `kast_base_wallets` テーブルにはエントリ追加のみで削除がないため、過去履歴を保持
- もし KAST が将来 service を停止しても、過去のKAST users record は維持される
- これは note 記事用の time-series 分析に有用

---

## 7. このphase完了で達成されること

masanoriさんが当初の質問「KASTユーザーがどれくらいKAST Earn を使っているか」に対して、

**ダッシュボードで「KAST users only」トグルをON にするだけで、KAST onboarded users の Earn TVL分布が定量的に可視化される**

状態が完成します。両サービス (USDKY + Gauntlet) について同じ抽象化で表示できるため、masanoriさんが KAST community 向けに「**KAST Earn の retail TVL 全体像**」を示すツールが完成します。

Phase 11 以降の候補:
- HYPE staking 統合 (Hyperliquid)
- 個人ポートフォリオビュー (自分のwalletだけ時系列表示)
- KAST team 公式数字との突き合わせ
- 「Field Deployed Engineering 観点での KAST Earn structure 解明」note記事化
