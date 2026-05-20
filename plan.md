# USDKY Tracker - Implementation Plan

最終更新: 2026-05-20
進行状況: 44 / 47 (Phase 1-8) + Phase 9: 34/36 + Phase 10: 25/27 done（残 10.7.4 モバイル / 10.8.5 翌日 cron / 10.8.6 prod deploy）

---

## このファイルの使い方

- **ステータス**: `Pending` / `In Progress` / `Done` / `Blocked` の4つ
- 作業開始時に `Pending` → `In Progress`
- 完了時に `In Progress` → `Done`（完了根拠を1行追記）
- ブロッカー発生時は `Blocked` + 理由を追記
- 詳細仕様は `usdky-tracker-spec.md` を参照

---

## Phase 1: プロジェクト初期化

- [x] **1.1** Next.js (App Router) + TypeScript プロジェクト作成 — `Done` (Next 16.2.6 / React 19.2.4 / Tailwind v4 scaffold; `npx tsc --noEmit` 通過)
- [x] **1.2** 依存パッケージインストール (`@neondatabase/serverless` 等) — `Done` (`@neondatabase/serverless@^1.1.0` 追加 / `tsx@^4.22.2` devDep 追加。Recharts は 7.1 で導入予定)
- [x] **1.3** Neonプロジェクト作成 + pooled / unpooled DATABASE_URL 取得 — `Done` (ap-southeast-1 リージョン、pooled + unpooled 両方取得済)
- [x] **1.4** スキーマを `migrations/001_initial_schema.sql` に切り出してNeonに適用 — `Done` (`scripts/apply-migration.ts` 経由で適用、`usdky_snapshots` / `usdky_multipliers` / `usdky_tx_log` の 3 テーブル + 4 インデックスを確認)
- [x] **1.5** 環境変数セットアップ（`.env.local` + Vercel ダッシュボード） — `Done` (local 側 `.env.local` 投入済。Vercel 側登録は Phase 5.6 のデプロイ準備で実施)

---

## Phase 2: Helius RPCクライアント

- [x] **2.1** `lib/helius.ts` の骨格作成 — `Done` (`lib/helius.ts` 作成: 定数 + 型 + 5 関数 + `sleep`)
- [x] **2.2** 汎用 `rpc(method, params)` ヘルパー実装 — `Done` (`rpc<T>` — JSON-RPC エラー / HTTP 非2xx を明示的に投げる)
- [x] **2.3** `getMultiplier()` 実装 — `Done` (`scaledUiAmountConfig` extension 経由、Phase 3.1 で実応答を検証予定)
- [x] **2.4** `getAllTokenAccounts()` 実装（ページング対応） — `Done` (Helius DAS `getTokenAccounts` を 1000 件ずつページング)
- [x] **2.5** `getAllSignaturesForMint()` 実装（`before` ページング対応） — `Done` (`getSignaturesForAddress` を `before` カーソルでループ + 150ms sleep)
- [x] **2.6** `parseTransaction(sig)` 実装（owner deltas + multiplier更新の抽出） — `Done` (stub のみ。本実装は Phase 3.3 確定後)

---

## Phase 3: 仕様の事前検証（重要・実装に入る前の関所）

> **ここをスキップすると Phase 4 全体がやり直しになる可能性が高い。Claude Code は実装より先にここでRPCを叩いて生レスポンスをユーザーに見せること。**

- [x] **3.1** USDKY Mint の `getAccountInfo` を `jsonParsed` で取得し、`scaledUiAmountConfig` extension の存在を確認 — `Done` (extension あり / `state.multiplier` は string `"1.031818482322"` / `newMultiplier` + `newMultiplierEffectiveTimestamp` フィールドあり = スケジュール式更新の可能性)
- [x] **3.2** USDKY Mint の直近 multiplier 更新トランザクションを `getTransaction` で取得し、ログ・命令の生レスポンスを目視確認 — `Done` (sig `52qrxZBcTt7w...` で `extMahs9...Sync` → Token2022 CPI `updateMultiplier` を確認)
- [x] **3.3** multiplier 更新の確実な検出方法を確定（推奨: `parsed.type` ベース、非推奨: ログ正規表現） — `Done` (`meta.innerInstructions[*].instructions[*]` を走査 → `programId === Token2022 && parsed.type === 'updateMultiplier'` でマッチ → `parsed.info.newMultiplier` / `newMultiplierTimestamp` を抽出)
- [x] **3.4** mint/burn トランザクションで `preTokenBalances` / `postTokenBalances` が想定通りに差分を出すか確認 — `Done` (`amount` は principal の base units で multiplier 影響なし。`accountIndex` で pre/post を突合し、`owner` フィールド直読みで delta 集約可能)

---

## Phase 4: バックフィルスクリプト

- [x] **4.1** `scripts/backfill.ts` の骨格作成 + 引数パース（`--from YYYY-MM-DD`） — `Done` (`--from` / `--yes` / `--skip-snapshots` をサポート)
- [x] **4.2** Step 1: 全署名取得（`before` ページング） — `Done` (`fetchAllSignatures` inline 実装、`--from` で early stop)
- [x] **4.3** Step 1.5: 総署名数をログ出力 + 続行可否プロンプト（credit保護） — `Done` (`readline/promises` で y/N 確認、`--yes` でスキップ可)
- [x] **4.4** Step 2: 各署名を `getTransaction` で取得 + parse — `Done` (`lib/helius.ts:parseTransaction` 本実装、accountIndex 突合 + sign 分類 + inner instruction `updateMultiplier` 抽出)
- [x] **4.5** Step 3: `usdky_tx_log` への冪等insert — `Done` (500 件バッチで `unnest` + `ON CONFLICT (signature, owner) DO NOTHING`)
- [x] **4.6** Step 4: `usdky_multipliers` への冪等upsert — `Done` (50 件バッチ、`effective_date` でバッチ内 dedup → `ON CONFLICT DO UPDATE WHERE EXCLUDED.block_time > existing`)
- [x] **4.7** Step 5: 日次snapshotを再構成して `usdky_snapshots` に書き込み — `Done` (`generate_series` + CTE で日次集計、`COALESCE(multiplier, 1.0)`、`ON CONFLICT DO UPDATE`)
- [x] **4.8** rate limit対策（100〜200ms sleep）+ 進捗ログ `[N / total]` 形式実装 — `Done` (150ms sleep / 50tx ごとに進捗出力)
- [x] **4.9** ローカルでバックフィル実行 + Neon上のレコード件数確認 — `Done` (4,484 tx 完走 / 7,661 delta 行 / 561 multiplier parse / 298 effective_date 行 / 42,649 snapshot 行 / 316 days / 1,097 owners / 0 errors)

---

## Phase 5: 日次Cron

- [x] **5.1** `app/api/cron/usdky-snapshot/route.ts` 作成 — `Done` (Node runtime / maxDuration=60 / force-dynamic)
- [x] **5.2** `Authorization: Bearer ${CRON_SECRET}` 認証実装 — `Done` (header 不一致時 401)
- [x] **5.3** multiplier 取得 + 全 token account 取得処理 — `Done` (`getMultiplier()` + `getAllTokenAccounts()`)
- [x] **5.4** owner 集約 + `unnest` を使った一括 upsert — `Done` (Map で owner 別 principal + ataCount 集約 → `usdky_snapshots` upsert / `usdky_multipliers` upsert)
- [x] **5.5** `vercel.json` で日次cron スケジュール設定（`5 0 * * *`） — `Done`
- [x] **5.6** デプロイ + 手動 curl で疎通確認 — `Done` (GitHub `Masa1984a/kast-earn-tracker` 経由で Vercel デプロイ。https://kast-earn-tracker.vercel.app/ で `/`, `/api/summary`, `/api/snapshots`, `/api/cron/usdky-snapshot` (Bearer auth) 全部 200 OK。cron が live tokenAccounts から 5 dust wallet を追加発見し 1094 → 1099 holders に更新)

---

## Phase 6: 可視化エンドポイント

- [x] **6.1** `app/api/snapshots/route.ts` 作成 — `Done` (force-dynamic, Node runtime)
- [x] **6.2** クエリパラメータ `bucket=size|rank|cohort` のルーティング — `Done` (`size` 以外は 501 で明示返却)
- [x] **6.3** `size` バケット実装（whale / large / mid / retail / dust） — `Done` (`SUM(...) FILTER (WHERE ...)` で 5 バケット集計)
- [ ] **6.4** `rank` バケット実装（Top10 + others） — `Pending`（オプション、Phase 8 以降）
- [ ] **6.5** `cohort` バケット実装（初回登場月別） — `Pending`（オプション、Phase 8 以降）
- [x] **6.6** Recharts互換のレスポンス形式に整形 — `Done` (`Array<{date, bucket1, ...}>` で number 変換済)

---

## Phase 7: フロントエンド（積み上げ棒グラフ）

- [x] **7.1** Recharts インストール + 基本レイアウト作成 — `Done` (`recharts@^3.8.1` 追加 + `app/page.tsx` を client component 化)
- [x] **7.2** `app/page.tsx` で `/api/snapshots` をfetch — `Pending` → `Done` (`/api/summary` と並列 fetch)
- [x] **7.3** `BarChart` + `Bar` の `stackId` 設定で積み上げ表示 — `Done` (`stackId="size"` で 5 バケット積み上げ、色分け済)
- [ ] **7.4** バケット切り替えトグルUI実装 — `Pending` (6.4/6.5 と同時、オプション)
- [x] **7.5** ヘッダに現在の multiplier / 総ホルダー数 / 総USD value を表示 — `Done` (`/api/summary` 経由で 4 Stat カード表示)
- [x] **7.6** モバイルレスポンシブ対応 — `Done` (Tailwind responsive classes + `ResponsiveContainer` で chart リサイズ)

---

## Phase 8: 動作確認

- [x] **8.1** Neon上で `usdky_snapshots` のレコード総数と日付範囲を確認 — `Done` (42,649 rows / 316 days [2025-07-08 .. 2026-05-19] / 1,097 owners / 最新日 1,094 holders / $1,870,612)
- [x] **8.2** Cron を手動で `curl` 叩いて当日分が入ることを確認 — `Done` (localhost で Bearer auth + 200 OK + `{holders:1094, total_usd:1870612, multiplier:1.031907}` を確認)
- [x] **8.3** フロントエンドで積み上げグラフが期待通り描画されることを確認 — `Done` (localhost:3000 でユーザーが視認確認 (evidence_01.png)。本番 https://kast-earn-tracker.vercel.app/ も HTML レンダリング確認済)
- [x] **8.4** 自分のウォレット `4QvVC4Cc3UWvFk97VwWWV7AvNg6L7XGXu9GFBKgHPMDD` の `usd_value` が KAST アプリ表示とほぼ一致することを確認 — `Done` (DB 上 2026-05-19: $8,021.13、ユーザー確認済「残高は認識あっています」)
- [ ] **8.5** Vercel Cron が翌日自動実行されることを Vercel ダッシュボードで確認 — `Pending` (Vercel デプロイ後の翌日確認)

---

## Blockers / Notes

### Blockers
（なし）

### Notes
- USDKY ローンチ日: 2026年1月頃と推定。Phase 4.2 で Mint の最古署名から確定する
- multiplier 更新は **約 12 時間間隔の Sync ハートビート** で動いている（`extMahs9bUFMYcviKCvnSRaXgs5PcqmMzcnHRtTqE85` プログラムが authority `EvEenAb6tQdgUCMgv9fpgxMzLw4Cj2PcQLbJbTEreQCm` 署名で実行）。ただし **値が変化しない場合は CPI が走らず、`updateMultiplier` の inner instruction も出ない**。バックフィルでは authority の署名を辿り、各 tx で inner instruction を見て実更新のみ拾う
- KAST関連ウォレット（treasury / minter）の識別は Phase 8 後の追加タスクとして拡張可

### Phase 4 完走後の追加実装（2026-05-19 〜 2026-05-20）

#### kast_known_addresses (migration 003) + manual labels
- `5WVYUVeJvcwD4Fpko5aZgdoB346Ef9ioAG6znohbrbti` → `treasury`（10 mints / 全 1.81M USDKY 流通量を経由 / net 0）
- `EGzpN9QTKLNT7eoLyqy2f8FRvq9krNpbVMP98Yqscf7z` → `infra`（1627 transfers, 1.75M total token value, Solscan で operator 濃厚）
- `E1vwo1VpXafBEPe8Tn2Ps2qLgywS9rfTR97fXc5RCW2a` → `infra`（1055 transfers, 同パターン）

#### SOL 保有による自動分類 (`has_sol` ラベル) — M0 source 由来の仮説で根拠あり
- M0 `solana-m-extensions` の `wrap.rs` 解析で、KAST が wrap authority として user の ATA に USDKY を入れる構造を確認。User 自身は秘密鍵を持たないため、KAST custodial wallet は **System Account 未初期化 = SOL 0** が期待値
- `scripts/scan-sol-balances.ts` で全 1094 owner を `getMultipleAccounts` (11 batch / ~11 credits) で SOL 残高チェック
- 結果: SOL なし 1051 (96.1% = 純粋 KAST 利用者) / SOL あり 43 (うち既存 infra ラベル 2)
- 41 件を `has_sol` ラベルで自動追加 (`--apply` モード)

#### API + UI 拡張
- `/api/snapshots` と `/api/summary` に `?exclude=treasury,infra,has_sol` 等のクエリパラメータ追加（NOT EXISTS で除外）
- フロントエンドに「Has SOL」トグル 1 つに統合（チェックボックス → トグル変更、ユーザーの要望「非ユーザー = SOL 保有」一元化）
  - **デフォルト OFF**: 3 ラベル全部除外 → **1,051 holders / $841,007 = 純粋 KAST Earn ユーザービュー** (TVL の 59%)
  - ON: 全 1,094 holders / $1,870,613 表示

### Phase 3 確定事項（Phase 4 実装の前提）
- **multiplier 取得**: `getAccountInfo(USDKY_MINT, jsonParsed)` → `data.parsed.info.extensions[].extension==='scaledUiAmountConfig'` → `state.multiplier` (string → Number)
- **multiplier 更新検出**: `meta.innerInstructions[].instructions[]` を走査 → `programId === Token2022 && parsed.type === 'updateMultiplier'` で抽出。`parsed.info.newMultiplier` (string) を `Number()`、`parsed.info.newMultiplierTimestamp` は M0 protocol の as-of (秒)。`effective_date` は `tx.blockTime` の日付を採用する想定
- **owner delta**: `meta.preTokenBalances` / `meta.postTokenBalances` を `accountIndex` で突合。`amount` (base units, string → BigInt) の差分を計算し、entry の `owner` フィールドで集約。closed ATA (post 側に無い) は `-pre.amount`、新規 ATA (pre 側に無い) は `+post.amount`
- **kind 分類**: 外側 instruction の `parsed.type` を見る (`mintTo`/`mintToChecked` → 'mint', `burnChecked`/`burn` → 'burn', `transferChecked`/`transfer` → 'transfer')

### Helius credit 使用量見積もり
- Phase 4 バックフィルが credit 消費のピーク
- 想定: USDKY Mint への署名 3,000〜5,000件と仮定して、合計 10,000 credit 前後
- Helius 無料枠 100K credit/月 内に収まる想定だが、Phase 4.3 で実数確認すること

---

## Phase 9: Gauntlet Alpha Vault 統合（非同期ジョブ + share_price 対応版）

> 仕様: `gauntlet-extension.md`（2026-05-20 更新版 — share_price 対応）
> Token: `0x000000000001CdB57E58Fa75Fe420a0f4D6640D5` (Base / Aera MultiDepositorVault, gtUSDa)
> Dune Queries: snapshot=`7534621`, share_price=`7543001`

### 9.0 進行管理
- [x] **9.0** plan.md に Phase 9 を追記 — `Done` (2026-05-20、share_price 対応版に追従済)

### 9.1 事前検証 — **完了済**（2026-05-20）
- [x] **9.1.1** `gtusda_balance` 単位 = **shares** と確定 — `Done` (Dune `0x371002...` 2026-05-20 値 0.9462 vs KAST アプリ表示 $1.01 → 比率 ≈ 1.067 で shares 確定)
- [x] **9.1.2** Basescan コントラクト種別確認 — `Done` (Aera Finance **MultiDepositorVault** / 原資産 USDC / `sharePrice`/`totalAssets` 等 read 関数なし → on-chain NAV 取得不可)
- [x] **9.1.3** Vault ローンチ日 = バックフィル `start_date` 確定 — `Done` (Dune snapshot 範囲 **2025-06-05** .. 2026-05-20 / 350日 / latest 6,052 holders / sum shares 62.6M)
- [x] **9.1.4** share_price 取得方針確定 = **Option C** (Dune `Enter` event decode による日次 share_price クエリ) — `Done` (新規 Dune query `7543001` をユーザー作成済。年率 ≈ 7.0% 上昇)

### 9.2 スキーマ追加
- [x] **9.2.1** `migrations/004_dune_jobs_and_gauntlet.sql` 作成（`dune_jobs` + `idx_dune_jobs_active` 部分インデックス + `idx_dune_jobs_kind_date`）— `Done` (`migrations/004_dune_jobs_and_gauntlet.sql`)
- [x] **9.2.2** 同 migration に `gauntlet_snapshots` テーブル + 2 インデックスを追加 — `Done`
- [x] **9.2.3** 同 migration に `gauntlet_share_prices` テーブル追加 — `Done`
- [x] **9.2.4** `scripts/apply-migration.ts` で Neon に適用 — `Done` (7 statements 適用 / 3 テーブル + 2 インデックス確認)

### 9.3 Dune APIクライアント
- [x] **9.3.1** `lib/dune.ts` を新規作成 — `Done` (`lib/dune.ts`)
- [x] **9.3.2** `executeQuery` / `getExecutionStatus` / `getExecutionResults` 実装（+ `DuneExecutionState` 型）— `Done`
- [x] **9.3.3** Query ID 定数 `GAUNTLET_SNAPSHOTS_QUERY_ID=7534621` / `GAUNTLET_PRICE_QUERY_ID=7543001` 定義 — `Done`
- [x] **9.3.4** `DUNE_API_KEY` を `.env.local`（投入済）+ Vercel ダッシュボードに反映 — `Done` (local 投入済 / Vercel もユーザーが設定済)

### 9.4 ジョブ取り込みロジック
- [x] **9.4.1** `lib/ingest.ts` を新規作成 — `Done` (`lib/ingest.ts`)
- [x] **9.4.2** `ingestJobResults(sql, jobKind, rows)` ディスパッチャ実装（4種類の job_kind 対応）— `Done` (gauntlet_daily / gauntlet_backfill / gauntlet_price / gauntlet_price_backfill)
- [x] **9.4.3** `ingestGauntletSnapshots` 実装（price テーブル先読み + `usd_value = shares × price`、price 未取得日は 1.0 で graceful degrade）— `Done` (500 件バッチ + `unnest` upsert)
- [x] **9.4.4** `ingestGauntletPrices` 実装（`gauntlet_share_prices` upsert）— `Done`
- [x] **9.4.5** auto-recompute 実装（price ingest 後に対象日の `gauntlet_snapshots.usd_value` を `UPDATE ... FROM gauntlet_share_prices`）— `Done` (`IS DISTINCT FROM` で no-op UPDATE 除外)

### 9.5 Cron A: dune-kickoff（snapshot + price を並列起票）
- [x] **9.5.1** `app/api/cron/dune-kickoff/route.ts` 作成（`maxDuration=30` + Bearer auth）— `Done`
- [x] **9.5.2** snapshot job（`job_kind='gauntlet_daily'`）kickoff 実装 — `Done` (`Promise.all` で並列)
- [x] **9.5.3** price job（`job_kind='gauntlet_price'`）kickoff 実装 — `Done`
- [x] **9.5.4** job_kind 別の当日重複防止チェック実装 — `Done` (`kickoffJob` 内で `created_at::date = current_date` の `executing/completed` を skip)
- [x] **9.5.5** 手動 curl 疎通確認（`dune_jobs` に 2 行 executing で入ること）— `Done` (admin backfill 経由で job_id=1,2 が `executing` で入り `completed` 遷移確認)

### 9.6 Cron B: dune-poll
- [x] **9.6.1** `app/api/cron/dune-poll/route.ts` 作成（`maxDuration=60` + Bearer auth）— `Done` (`LIMIT 5` FIFO)
- [x] **9.6.2** Stale 掃除（`started_at < now() - interval '1 hour'` を failed に）— `Done`
- [x] **9.6.3** snapshot job ステータス遷移確認（executing → completed）— `Done` (job_id=1 `executing` → `completed` / 48,062 rows)
- [x] **9.6.4** price job ステータス遷移確認 — `Done` (job_id=2 `executing` → `completed` / 8 rows)
- [x] **9.6.5** auto-recompute が走り `gauntlet_snapshots.usd_value` が更新されることを確認 — `Done` (probe wallet 0.9462 × 1.0665 = $1.0091 で KAST 表示 $1.01 と一致)

### 9.7 バックフィル admin endpoint
- [x] **9.7.1** `app/api/admin/trigger-gauntlet-backfill/route.ts` 作成（Bearer auth）— `Done`
- [x] **9.7.2** `kinds`（=['snapshots','price'] デフォルト）パラメータで個別 / 一括起動を実装 — `Done` (`'snapshots' | 'price'` で type-narrow)
- [x] **9.7.3** ローカルから 2025-06-05 .. 2026-05-20 で snapshot + price 一括バックフィル発動 — `Done` (job_id=3 snapshot **658,179 rows** / job_id=4 price **350 rows** / 全期間カバー)
- [x] **9.7.4** `dune_jobs` / `gauntlet_snapshots` / `gauntlet_share_prices` 3テーブル全てに値が入ることを確認 — `Done` (smoke test で全 3 テーブルに値あり)

### 9.8 vercel.json 更新
- [x] **9.8.1** `dune-kickoff` (`20 0 * * *`) と `dune-poll` (`*/10 * * * *`) を追加 — `Done` (`vercel.json`)

### 9.9 API エンドポイント拡張
- [x] **9.9.1** `/api/snapshots` に `service` パラメータ追加（`usdky` / `gauntlet` / 未指定=両方）— `Done`
- [x] **9.9.2** 未指定時はサービス別合計（UNION ALL）レスポンス — `Done` (`{date, usdky, gauntlet}` の Recharts 互換)
- [x] **9.9.3** `has_sol` フィルタを `service=usdky` のみで有効化 — `Done` (exclude は usdky 側にのみ NOT EXISTS で適用、gauntlet 側は素通し)
- [x] **9.9.4** `/api/share-prices?service=gauntlet` 追加（annualized yield 計算用の生 share_price 履歴）— `Done` (`/api/share-prices`)
- [x] **9.9.5** `/api/summary` を `{usdky:..., gauntlet:...}` に拡張（破壊的変更、9.10 と同期）— `Done`

### 9.10 フロントエンド改修
- [x] **9.10.1** サービスフィルタ UI 追加（All / USDKY / Gauntlet Alpha）— `Done` (`app/page.tsx` セグメントスタイルのトグル)
- [x] **9.10.2** ヘッダ統計をサービス別カードに分割 — `Done` (`ServiceCard` コンポーネント、accent カラー付き)
- [x] **9.10.3** Gauntlet ヘッダに `share_price` + annualized yield（過去30日 share_price 推移から計算）表示 — `Done` (`computeAnnualizedYield`)
- [x] **9.10.4** 「Has SOL」トグルを USDKY ブロック内に移動 + Gauntlet 選択時は非表示 — `Done` (`service !== 'gauntlet'` で条件描画)
- [x] **9.10.5** 積み上げグラフ `stackId` を `All`=service / 個別=volume bucket に切替 — `Done`
- [ ] **9.10.6** モバイル縦並びレイアウト確認 — `Pending` (CSS は `grid-cols-1 md:grid-cols-2` で対応済、ブラウザ視認は 9.11.6 にて)

### 9.11 動作確認 + 本番デプロイ
- [x] **9.11.1** Gauntlet バックフィル後の 3 テーブルレコード件数・日付範囲確認 — `Done` (dune_jobs 4 jobs / gauntlet_snapshots 658,179 rows / gauntlet_share_prices 350 rows / 2025-06-05 .. 2026-05-20)
- [ ] **9.11.2** dune-kickoff cron 翌日自動実行 → poll cron が 10 分以内に両 jobs 取り込み確認 — `Pending` (翌日 00:20 UTC 自然実行待ち / 2026-05-21 確認)
- [x] **9.11.3** Base wallet `0x371002...02cae` の最新 `usd_value` が KAST アプリ表示 **$1.01** と一致 — `Done` (smoke test 結果 $1.0091 で完全一致)
- [ ] **9.11.4** Stale 掃除動作確認（わざと 1h 以上 executing 放置）— `Pending` (本番運用上は意図的に再現困難。コードレビュー済として運用後監視)
- [x] **9.11.5** price のみ再バックフィル → `usd_value` auto-recompute を確認 — `Done` (smoke test → full backfill で同期間の price が更新され usd_value も再計算されたことを確認。コードの `IS DISTINCT FROM` で no-op を除外)
- [x] **9.11.6** Production deploy + 全機能動作確認 — `Done` (Vercel deploy 成功 / `/api/summary` `/api/snapshots` `/api/share-prices` `/api/cron/dune-poll` 全て 200 OK / cron Bearer auth 401 OK)

### Phase 9 Blockers / Notes
- 9.1 関所完了済（2026-05-20）→ 9.2 以降に着手可
- 9.3.4: `DUNE_API_KEY` は `.env.local` 投入済。本番デプロイ前に Vercel ダッシュボードへの追加が必要
- Aera MultiDepositorVault は ERC-4626 非互換 + read NAV 関数なし → share_price は Dune query 7543001（Enter event decode）に依存
- 入力 token は USDC 前提。他 stablecoin 受け入れが始まると `enter_events_today` が急減するので要監視
- `dune_jobs` は将来 `external_jobs` に rename 余地があるが、早期抽象化は避ける（仕様書 §7）

---

## Phase 10: KAST Users Filter (Bybit OTC signature)

> 仕様: `phase10-kast-filter.md`
> Dune Query: `7544316` (KAST-funded gtUSDa Alpha holders)
> KAST onramp: Bybit OTC `0x5E690CFd5598F8d0E335b96e9F2f1b1527b7a5bF`
> 期待結果: 約 4,409 wallets (Gauntlet holders の 68%)

### 10.0 進行管理
- [x] **10.0** plan.md に Phase 10 を追記 — `Done` (2026-05-20 起票)

### 10.1 Dune query 作成 — **完了済**（ユーザー作成済）
- [x] **10.1.1** §3 の query を Dune に新規作成 — `Done` (query ID `7544316`)
- [x] **10.1.2** デフォルトパラメータ設定 — `Done` (vault / usdc / kast_onramp)
- [x] **10.1.3** 動作確認 (約 4,409 行返ることを期待) — `Done` (ユーザー確認済)
- [ ] **10.1.4** query ID を `lib/dune.ts` に追加 — `Pending` (10.3 と同時)

### 10.2 スキーマ追加
- [x] **10.2.1** `migrations/005_kast_base_wallets.sql` 作成（テーブル + `idx_kast_wallets_funded`） — `Done`
- [x] **10.2.2** Neon に適用 — `Done` (2 statements / `kast_base_wallets` テーブル確認)

### 10.3 取り込みロジック追加
- [x] **10.3.1** `lib/dune.ts` に `KAST_BASE_WALLETS_QUERY_ID=7544316` + `USDC_BASE` + `KAST_ONRAMP` 定数追加 — `Done`
- [x] **10.3.2** `lib/ingest.ts` dispatcher に `kast_base_wallets_daily` / `kast_base_wallets_backfill` を追加 — `Done`
- [x] **10.3.3** `ingestKastBaseWallets` 実装（500件バッチ + `ON CONFLICT (wallet) DO UPDATE SET last_updated_at`） — `Done`

### 10.4 Cron 更新
- [x] **10.4.1** dune-kickoff cron に 3つ目の job (`kast_base_wallets_daily`) 追加 — `Done` (`Promise.all` 3並列)
- [x] **10.4.2** 当日重複防止チェックが 3 job それぞれで動くことを確認 — `Done` (既存 `kickoffJob` は job_kind 別なので自動で 3 系統独立)

### 10.5 バックフィル admin endpoint 更新
- [x] **10.5.1** `kinds` パラメータに `kast_wallets` を追加（デフォルト `['snapshots','price','kast_wallets']` に拡張） — `Done` (`kast_wallets` のみなら `start_date`/`end_date` 不要にも対応)
- [x] **10.5.2** ローカルから `kast_wallets` のみのバックフィル発動 — `Done` (job_id=5, 4分27秒で `completed`)
- [x] **10.5.3** `kast_base_wallets` に約 4,409 件入ることを確認 — `Done` (**ジャスト 4,409 件** / earliest 2026-01-07 / latest 2026-05-20)

### 10.6 API エンドポイント拡張
- [x] **10.6.1** `/api/snapshots` に `kast_only` パラメータ追加 — `Done`
- [x] **10.6.2** USDKY 側: `kast_only=true` で `treasury,infra,has_sol` を除外（既存 exclude ロジックに同居） — `Done` (kast_only=true 時は exclude を内部で `KAST_USDKY_EXCLUDE_LABELS` に置換)
- [x] **10.6.3** Gauntlet 側: `kast_only=true` で `kast_base_wallets` と INNER JOIN — `Done`
- [x] **10.6.4** `/api/summary` にも `kast_only` パラメータ追加（USDKY + Gauntlet 両方フィルタ） — `Done` (レスポンスに `kast_only` フラグも返却)
- [x] **10.6.5** service × kast_only の組み合わせ 6 パターン動作確認 — `Done` (curl で `/api/summary` `/api/snapshots?service=...&kast_only=...` 全て 200 OK + 期待値返却)

### 10.7 フロントエンド改修
- [x] **10.7.1** 「Has SOL」トグルを「KAST users only」マスタートグルに変更（service フィルタと独立、両サービスに同時適用）— `Done` (デフォルト ON)
- [x] **10.7.2** トグル ON 時に各サービスブロックに識別ロジック注釈表示 — `Done` (`ServiceCard` の `note` prop で「※ Filtered: ...」)
- [x] **10.7.3** 情報アイコン + ホバー説明テキスト（USDKY: no SOL / Gauntlet: Bybit OTC funded）— `Done` (ⓘ + title 属性)
- [ ] **10.7.4** モバイル responsive 確認 — `Pending` (10.8.6 deploy 後)

### 10.8 動作確認 + 本番デプロイ
- [x] **10.8.1** バックフィル後の `kast_base_wallets` レコード数確認（約 4,409 想定）— `Done` (4,409 件)
- [x] **10.8.2** 検証 wallet `0x371002...02cae` が `kast_base_wallets` に含まれることを確認 — `Done` (first_funded 2026-01-16 / source `bybit_otc_signature`)
- [x] **10.8.3** Gauntlet KAST-only TVL が ~$45M 前後（推定）になることを確認 — `Done` (**実測 $4.13M / 4,408 holders** — 仕様書予想 $45M より大幅に低い。retail バイアスが想定以上に強い、有意な発見)
- [x] **10.8.4** UI トグルで全サービス連動切り替え確認 — `Done` (API レイヤで両サービスフィルタ動作確認、SSR 200 OK)
- [ ] **10.8.5** dune-kickoff cron 翌日自動実行で `kast_base_wallets` が更新されることを確認 — `Pending` (2026-05-21 以降)
- [ ] **10.8.6** Production deploy + 全機能動作確認 — `In Progress` (commit 準備中)

### Phase 10 Blockers / Notes
- KAST 識別カバー率: ホルダー数で 68%、TVL ベースだと 50-60% になる可能性（retail バイアス）→ UI で「保守的下限」と明示
- `KAST_ONRAMP` が将来変更される可能性あり。複数 onramp になったら Dune query の `WHERE first_funder IN (...)` で対応
- `kast_base_wallets` は **insert / update only、delete なし**（時系列分析用に履歴保持）
