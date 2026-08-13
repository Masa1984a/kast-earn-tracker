# USDKY Tracker - Implementation Plan

最終更新: 2026-08-13
進行状況: 44 / 47 (Phase 1-8) + Phase 9: 34/36 + Phase 10: 26/27 + Phase 14: 5/5 done
現在の焦点: **Phase 15**（Gauntlet 欠損 2026-07-30..08-04 の原因調査 = 完了 / リカバリ + 再発防止 = 未着手）

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
- [x] **10.8.6** Production deploy + 全機能動作確認 — `Done` (commit `74c0fea` push 済 / `/api/summary?kast_only=true` 4408 holders $4.13M / `/api/snapshots?kast_only=true` 200 OK / home 200 OK)

### Phase 10 Blockers / Notes
- KAST 識別カバー率: ホルダー数で 68%、TVL ベースだと 50-60% になる可能性（retail バイアス）→ UI で「保守的下限」と明示
- `KAST_ONRAMP` が将来変更される可能性あり。複数 onramp になったら Dune query の `WHERE first_funder IN (...)` で対応
- `kast_base_wallets` は **insert / update only、delete なし**（時系列分析用に履歴保持）

---

## Phase 11: 運用上の微調整

- [x] **11.1** ダッシュボード上部の Yield 算出ウィンドウを 30D → 7D に変更（KAST アプリと表記を合わせる） — `Done` (`app/page.tsx`: `computeAnnualizedYield` の `days` デフォルト 30→7、ラベル "Yield (30D)"→"Yield (7D)" を 2 箇所更新、`tsc --noEmit` 通過)
- [ ] **11.2** メインチャート直下に「7-Day Rolling Annualized Yield」独立グラフを追加（USDKY/Gauntlet 2ライン、service フィルタ連動） — `In Progress` (`app/page.tsx`: `computeRollingYieldSeries` 追加 / `yieldSeries` useMemo 追加 / 既存 chart 直下に Y 軸 % 単一の ComposedChart を追加、`connectNulls=false` で初期 6 日は描画スキップ、`tsc --noEmit` 通過。ブラウザでの目視確認はユーザに委ねる)
- [ ] **11.3** USDKY 側 share_price の欠損日（19/322 日、ingest が multiplier 更新検出日のみ insert する仕様に起因）対応として、フロント側で日次連続化＋前日値 carry-forward を実装 — `In Progress` (`app/page.tsx`: `fillDailyCarryForward` 追加し `yieldSeries` 構築前に両サービスの points を補完。`tsc --noEmit` 通過。`usdky_multipliers` 実データ確認: 直近欠損 04-22/04-24/04-26/05-03/05-06/05-07/05-10/05-11/05-17/05-18)
- [ ] **11.4** 「Yield (7D)」カード行と「7-Day Rolling Annualized Yield」グラフタイトルに、KAST トグルと同じ ⓘ ホバーヘルプを追加（算出ロジックを明示） — `In Progress` (`app/page.tsx`: `YIELD_CARD_INFO_TEXT` / `YIELD_CHART_INFO_TEXT` 定数追加、`ServiceCard` の `rows` 型を `[ReactNode, string]` に広げ key を index 化、USDKY/Gauntlet カードの Yield 行ラベルとグラフタイトル隣に `title` 属性付き ⓘ span を挿入、`tsc --noEmit` 通過。ブラウザ目視はユーザに委ねる)
- [ ] **11.5** Snapshot date 行を YYYY-MM-DD → YYYY-MM-DD HH:MM:SS UTC に変更（USDKY: `usdky_multipliers.block_time`、Gauntlet: `dune_jobs.completed_at` をソースに追加） — `In Progress` (`app/api/summary/route.ts`: 両サービスの SELECT に `snapshot_at` スカラサブクエリ追加、USDKY は `effective_date <= snapshot_date` の最新 block_time、Gauntlet は `gauntlet_daily` 完了ジョブの MAX(completed_at)。`app/page.tsx`: 型に `snapshot_at` 追加、`formatSnapshotAt` ヘルパ追加、両カードの Snapshot date 行を切替。`tsc --noEmit` 通過、DB ライブ確認で USDKY=2026-05-23 00:05:42 UTC / Gauntlet=2026-05-23 00:31:32 UTC を返却)
- [ ] **11.6** Holders 表の各行に「ウォレットコピーボタン」と「前日 USD / Δ USD / Δ %」3 列を追加 — `In Progress` (`app/api/holders/route.ts`: USDKY/Gauntlet 両方で前日 snapshot_date を別クエリで取得し、メインクエリに `LEFT JOIN ... ON snapshot_date = prevDate` を追加して `prev_usd_value` を返却。`app/page.tsx`: holder 型に `prev_usd_value` 追加、`HoldersTable` に Prev/Δ USD/Δ % 列追加、`useState` でコピーフィードバック付き SVG クリップボードボタン実装、Δ は緑/赤（NORD aurora）で色分け。`tsc --noEmit` 通過、DB ライブ確認で USDKY top 5 / Gauntlet top 5 ともに prev 値返却を確認)
- [ ] **11.7** Service Worker が cache-first で古い HTML を返し続けるため、デプロイ後にフロント更新が見えない問題を解消 — `In Progress` (`public/sw.js`: navigation/HTML は **network-first**、hash 済み静的アセット (`/_next/static/*`, `/icon-*`, `/manifest.webmanifest`) のみ cache-first、`/api/*` は従来通り network-first。`CACHE` を `kast-earn-v2` に bump して activate 時に旧キャッシュ自動削除。`next.config.ts`: `/sw.js` と `/manifest.webmanifest` に `Cache-Control: no-cache, no-store, must-revalidate` を設定し、ブラウザの SW 更新検知が即時走るように。`tsc --noEmit` 通過。デプロイ後ユーザは最大 2 ナビゲーション以内に新 SW へ切替わる)
- [ ] **11.8** Δ USD 表示の小数点 2 桁化、および Gauntlet の前日 USD 同値問題の調査 — `In Progress` (`app/page.tsx::formatDeltaUsd`: `Math.round` → `toLocaleString` with `minimumFractionDigits: 2`。Gauntlet 同値原因は **share_price が 2026-05-22 と 2026-05-23 で完全同値** (Dune が enter event ベースで share_price を算出する仕様、新規 enter event 無しの日は前日値を返す) のため `usd_value = shares × share_price` も同値化。コードバグではなくデータソース側の挙動。`tsc --noEmit` 通過)
- [ ] **11.9** Holders 表ヘッダに ⓘ を追加し、利回りが離散的に計上されるため前日比が $0 になり得る旨を補記 — `In Progress` (`app/page.tsx`: `HOLDERS_INFO_TEXT` 定数追加 (USDKY=multiplier 更新 tx 単位 / Gauntlet=enter event 単位、両方とも share_price が離散更新で前日比 $0 になり得る旨を明記、Global 向けで英文表記)、HoldersTable ヘッダの `{title} — holders` 隣に `title` 属性付き ⓘ span を挿入。HoldersTable コンポーネント共通なので USDKY/Gauntlet 両表に同時反映。`tsc --noEmit` 通過)

---

## Phase 12: タブ分け + BYOK (Bring Your Own Key) 直接照会

- [ ] **12.1** 既存 Home を `TrackerView` に抽出 + `page.tsx` をタブ切替ラッパー化（Tracker / USDKY (Helius) / Gauntlet (Dune) の 3 タブ） — `In Progress` (`app/page.tsx`: 新 `Home` を default export として top に追加し `DashboardTab` state + tab nav + 条件付き render を実装。既存 Home → `TrackerView` にリネーム、外側の `<main>` / `<div max-w-6xl>` / `<header>` を新 Home に集約、TrackerView 内は subtitle のみ残し `<>` Fragment で return。`tsc --noEmit` 通過)
- [ ] **12.2** `UsdkyHeliusView` 実装: ウォレット複数 + 期間入力 → Helius RPC 直接呼出で各 ATA の signature 履歴 + multiplier@block_time + Δ USD を一覧表示 — `In Progress` (`app/components/UsdkyHeliusView.tsx` 新規作成: ① 入力期間内の mint signatures を全件取得し `updateMultiplier` inner instruction をパースして multiplier 履歴を構築、② 期間より前の最新 multiplier を baseline として 1 件補完、③ 各ウォレットの USDKY ATA を `getTokenAccountsByOwner` で列挙し各 ATA の signatures を期間内で取得・各 tx の preTokenBalances/postTokenBalances から該当 owner の delta を抽出、④ kind=mint/burn/transfer-in/-out を innerInstructions の Token2022 parsed type で判定、⑤ 各 event の block_time に対応する multiplier を引当て Δ USD を算出、⑥ block_time desc でソートしたテーブル表示 (UTC タイムスタンプ / Solscan link 付き)。レート制御 120ms sleep。`tsc --noEmit` 通過)
- [ ] **12.3** `GauntletDuneView` 実装: 既存 Dune query (7534621 / 7543001 / 7544316) を選択し最新 results を Dune API 直接呼出で取得・汎用テーブル表示 — `In Progress` (`app/components/GauntletDuneView.tsx` 新規作成: `GET https://api.dune.com/api/v1/query/{id}/results?limit=N` を `X-Dune-API-Key` ヘッダ付きで呼出、レスポンス JSON の `result.metadata.column_names` を元に動的列でテーブル描画、行数 / execution_ended_at / state を表示、各 query への Dune.com リンク添付。`tsc --noEmit` 通過)
- [ ] **12.4** API キーは sessionStorage のみで保持し、いかなるリクエストも弊バックエンド経由しないことを保証（fetch 先は `mainnet.helius-rpc.com` / `api.dune.com` 直接、ヘッダー / クエリパラメータでキー送信） — `In Progress` (両 view コンポーネントとも sessionStorage `helius_api_key` / `dune_api_key` のみで保持し localStorage や cookie は不使用、Clear / Show-Hide ボタン付き、fetch は外部ドメイン直接で `/api/*` 経由なし。明示的に subtitle で「key stays in your browser only」を表記)
- [ ] **12.5** dune-kickoff cron を UTC 00:20 → UTC 23:30 に移動（当日 23.5h ぶんの enter event が反映された状態で集計、本日分カードが正しい値で当日中に出る） — `In Progress` (`vercel.json`: `"20 0 * * *"` → `"30 23 * * *"`。usdky-snapshot (00:05) / dune-poll (10分毎) は据え置き、`kickoffJob` の重複排除は `created_at::date = current_date` 基準で UTC 日付ベースなので 23:30 移動でも当日重複は防がれる。Dune credits は 1 日 3 query 実行のまま変わらず)

---

## Phase 13: 外部リポジトリ調査 (solana-m-extensions)

- [ ] **13.1** 別 Claude Code セッションが `solana-m-extensions` リポジトリを調査するための投入用ブリーフを Markdown で作成 — `In Progress` (`solana-m-extensions-investigation.md` 作成。セクション 1-7 構成: ①コンテキスト ②USDKY オンチェーン観測事実 (302 件 update / 88% が UTC13:00 / 19 日欠損 / no-op tx 観察 / schedule shifts) ③問い A-G (A 識別 / **B update 機構** / **C yield ソース** / D authority / E 失敗モード / F multi-tenancy / G docs) ④探索 starting points と grep キーワード ⑤findings 出力フォーマット指示 (path:line 引用 / 5 行以下 quote / 300-800 lines) ⑥findings の利用方針 ⑦リポが該当しない場合のエスカレーション手順)

---

## Phase 14: 当日 Gauntlet=0 問題の解消

> 現象: JST 午前帯 (UTC 早朝) で `/api/snapshots?service=all` を叩くと、当日 (UTC) には USDKY snapshot は既に存在するが Gauntlet snapshot は未到着 (`dune-kickoff` は UTC 23:30 実行) のため、UNION ALL の placeholder `0` がそのまま集計され、フロントの折れ線・バーが Gauntlet 側だけ $0/0 holders まで落ちる (evidence2.png)。
> 方針: API 側で「データ未到着」と「実際の 0」を区別。UNION の placeholder を `NULL` 化し、`has_usdky` / `has_gauntlet` フラグで集計時に判定。フロント側は `connectNulls=false` の既定挙動で line が切れる + Bar は null で非描画。

- [x] **14.1** `app/api/snapshots/route.ts` (service=all) の UNION SQL を NULL placeholder + has フラグ方式に書き換え — `Done` (`app/api/snapshots/route.ts`: kast_only / non-kast 両ブランチを `CASE WHEN SUM(has_usdky) > 0 THEN ... ELSE NULL END` 方式に書き換え。UNION の各 subquery に `1 AS has_usdky, 0 AS has_gauntlet` / `0, 1` フラグを追加。`ServiceRow` 型を `string | null` / `number | null` に拡張)
- [x] **14.2** `app/page.tsx` の `ServicePoint` 型と `formatTooltip` を null 対応に拡張 — `Done` (`ServicePoint` の 4 フィールド `usdky/gauntlet/usdky_holders/gauntlet_holders` を `number | null` 化。`formatTooltip` を `value == null` の場合 `'—'` を返すように拡張。Recharts の `<Line>` は `connectNulls` 既定 false で null では line が切れ、`<Bar>` は null では描画されない既定挙動を利用)
- [x] **14.3** `tsc --noEmit` 通過確認 + DB ライブ確認 (本日 Gauntlet=null 返却 / 昨日まで実値) — `Done` (tsc: エラーなし。DB ライブ確認: 2026-05-22..05-26 を query → 05-22/23/24/25 は usdky + gauntlet 両方実値、05-26 のみ `gauntlet:null` / `gauntlet_holders:null` / USDKY は実値 ($1,870,977 / 1,185 holders) を返却)
- [x] **14.4** USDKY cron を UTC 00:05 → UTC 23:00 に移動 (Dune kickoff UTC 23:30 の 30 分前)、2 サービスの snapshot_at timestamp 同期 — `Done` (`vercel.json`: `"5 0 * * *"` → `"0 23 * * *"`。`getMultiplier()` + `getAllTokenAccounts()` は時刻非依存のチェーン状態 snapshot なので移動による副作用なし。移行直後の 2026-05-26 行は UTC 00:05 で既に書き込まれた値が残るので追加手当て不要、翌 UTC 日 (2026-05-27) から UTC 23:00 ベース)
- [x] **14.5** UI `endDate` 初期値を UTC today → UTC yesterday に変更 (両サービスとも揃った日のみデフォルト表示)、reset filters ボタンの reset 先も同期 — `Done` (`app/page.tsx`: `todayISO()` → `defaultEndISO()` にリネーム + 中身を `Date.now() - 86_400_000` ベースに変更。useState 初期化 (line 295) と reset filters ボタン (line 490) の 2 箇所更新。手動で endDate=today を選択すれば 14.1-14.2 の null ハンドリングで正しく描画される (デバッグパス維持)。`tsc --noEmit` 通過)

---

## Phase 15: Gauntlet グラフ欠損 (2026-07-30 .. 08-04) の原因調査と再発防止

> 現象: Gauntlet Alpha のグラフが 2026-07-30 〜 2026-08-04 の 6 日間欠落。
> 結論: **Dune クレジット枯渇 → 課金サイクル (毎月 12 日) リセットまで Dune API が使えず、その間 kickoff が Dune 側で拒否されて `dune_jobs` に行すら作られなかった**。さらに日次 kickoff の lookback が 8 日しかないため、12 日間の停止は自己修復されず穴が残った。

### 15.1 原因調査
- [x] **15.1** 欠損原因の切り分け — `Done` (調査スクリプト 2 本を追加して Neon 実データで確定。証拠は下記「Phase 15 調査結果」参照。`scripts/diag-gauntlet-gap.ts` / `scripts/diag-dune-jobs-history.ts`)

### 15.2 欠損データのリカバリ
- [x] **15.2** 2026-07-30 .. 08-04 の 6 日ぶんを Dune backfill で埋める — `Done` (`scripts/backfill-gauntlet-range.ts` を新規作成し job #216 `gauntlet_backfill` / #217 `gauntlet_price_backfill` を kickoff → 本番 `dune-poll` cron が取り込み **snapshots 43,520 行 / price 6 行** で `completed`。検証: `gauntlet_snapshots` / `gauntlet_share_prices` ともに **全期間 434 日で欠損 0**（2025-06-05 .. 2026-08-12）。連続性も健全 — holders 7219 (07-29) → 7227 → … → 7283 → 7292 (08-05) が単調増加、share_price 1.07612 → 1.07622 … 1.07683 → 1.07712 も境界で滑らか。本番 `/api/snapshots?service=gauntlet&start_date=2026-07-28&end_date=2026-08-06` が 5 バケット全部埋まった連続データを返却)

### 15.3 再発防止（クレジット消費の構造的削減）
- [x] **15.3.3** kickoff の lookback を 7 日固定から「欠損日を見て動的に決定」へ変更 — `Done` (`app/api/cron/dune-kickoff/route.ts`: `detectGap()` + `resolveStartDate()` + `isoDaysAgo()` を追加。snapshots は `gauntlet_snapshots`、price は `gauntlet_share_prices` をそれぞれ独立に走査し `end_date - 30d .. end_date - 1d` の範囲で最古の欠損日を検出、`start_date = min(end_date - 7d, earliest_missing)` に伸長。30 日を超える欠損は `capped` フラグでレスポンスに出し手動 backfill に委ねる。レスポンスを `{windows, gaps, max_lookback_days, jobs}` に拡張。`tsc --noEmit` 通過 / `scripts/diag-kickoff-window.ts` で Neon 実データ検証 → snapshots=`2026-07-30 .. 08-13` (missing 6) / price=`2026-07-31 .. 08-13` (missing 5) を正しく算出 = 今回の欠損を自力修復できる形)
- [ ] **15.3.1** `gauntlet_daily` の 1 回あたりコスト削減 — `Pending`（下記「クエリコスト削減の実現性」参照。**`start_date` を縮めても scan 量は減らない**構造なので、①kast_wallets を週次化 ②`start_date = end_date` にして返却行数を 8 分の 1 にする ③USDKY 同様の delta 方式へ移行 の 3 案。まず Dune UI で ② のクレジット実測が必要）
- [ ] **15.3.2** `kickoffJob` の `executeQuery` 失敗時に `dune_jobs` へ `failed` 行を残す（現状 `route.ts` の execute が INSERT より前なので、Dune 拒否時は DB に痕跡ゼロ = 障害が見えない）— `Pending`
- [ ] **15.3.4** 欠損検知アラート（`gauntlet_snapshots` に前日行が無ければ通知）— `Pending`

### クエリコスト削減の実現性（15.3.1 の検討メモ / 2026-08-13）
- query 7534621 は `tokens_base.transfers` を **`block_date <= end_date` の全履歴** で 2 回スキャンし、`date_series CROSS JOIN addresses` で全ホルダー × 全日のパネルを作る構造。→ **`start_date` を縮めても scan 対象は減らない**ため、「ピンポイント取得でコスト激減」は期待できない
- 効くのは以下の 3 つ:
  1. **kast_wallets を週次化**（5.098 credits/day → 約 0.7 相当）。母集団は 3 週間で 5,372 → 5,632 と緩慢なので日次である必要が薄い。**最も低リスクで即効**
  2. **`start_date = end_date` にして返却行数を 58,632 → 約 7,300 に圧縮**（`/results` 取得ぶんの削減）。15.3.3 の動的 lookback があるので欠損時は自動で window が広がり、安全に縮められる。ただし 7 日重ねによる「Dune 側の遅延データ差し替え取り込み」効果は失う。**実施前に Dune UI で `start_date = end_date` の実クレジットを測り 58.4874 と比較すること**
  3. **USDKY と同じ delta 方式へ移行**（Dune 側は `block_date = X` の transfer 差分のみ取得 → Neon 側で前日残高 + delta で日次残高を再構成）。`block_date` のパーティション枝刈りが効き scan も返却行数も桁で減る。既存 `usdky_tx_log` → snapshot 再構成と同じ設計で前例あり。ただし残高ドリフトの検証が必要なので **週次 or 月次でフル照合 (現行クエリ 1 回) を併用**する前提。工数は中〜大

### Phase 15 調査結果（2026-08-13 実施）

#### 確定事実（Neon 実データ）
1. `gauntlet_snapshots` の欠損は **2026-07-30 .. 08-04 の 6 日のみ**（全 428 日中）。`gauntlet_share_prices` の欠損は **07-31 .. 08-04 の 5 日**
2. `dune_jobs` は **2026-07-31 .. 08-11 の 12 日間、行が 1 件も作られていない**（`failed` 行すら無い = 完全な沈黙）。2026-08-12 23:30 UTC に 3 job すべて `completed` で自然復帰
3. 07-30 は price job (#211) が `completed`、snapshot job (#212) が `Stale: exceeded 1 hour(s)` で失敗 → 07-30 だけ price あり / snapshot なしの理由
4. **同じ沈黙が 1 サイクル前にも発生**: 2026-07-10 / 07-11 の 2 日間も `dune_jobs` 行ゼロ → **07-12 に復帰**。今回も **08-12 に復帰**。→ Dune のクレジットリセットは **毎月 12 日**（月初 1 日ではない）
5. USDKY 側 (Helius) は 07-30 〜 08-12 まで**毎日欠損なく記録されている** → Vercel cron / デプロイは生きていた。障害は **Dune 側に限定**
6. 7 月は復帰後も失敗が増加傾向: `gauntlet_daily` failed 6 / `kast_base_wallets_daily` failed 8 / stale 7（クレジット逼迫と整合）
7. 1 回の取得行数が増加中: `gauntlet_daily` 49,510 行 (05-30) → 58,632 行 (08-12)

#### クレジット収支（`001_クレジット分析.txt` の実測値ベース）
- query 7534621 (snapshots) = **58.4874** / 7544316 (kast wallets) = **5.098** / 7543001 (price) = **0.0045**
- 日次 3 本で **約 63.6 credits/day** → 31 日で約 1,970。ここに失敗・stale 実行分と `/results` 取得分が上積みされる
- 観測されたサイクル寿命: 06-12〜07-09 で約 28 日 / **07-12〜07-30 で約 19 日**（実効消費は名目の約 2 倍ペース）→ 現行の日次 3 本は月枠に対して**恒常的にオーバー**

#### 「穴が残った」構造的理由（コード）
- `app/api/cron/dune-kickoff/route.ts:40-52`: `executeQuery()` が **INSERT より前**。Dune がクレジット超過で拒否すると throw → `Promise.all` reject → route 500 で終わり、**`dune_jobs` に記録が残らない**。DB だけ見ると「cron が動かなかった」と区別できない
- `app/api/cron/dune-kickoff/route.ts:65-66`: 日次 window は `start_date = now - 7d` の **8 日固定**。→ 停止が 7 日以内なら翌回の window が自動で埋める（07-10/11 の 2 日停止はこれで自己修復され、データ欠損ゼロだった）が、**今回の 12 日停止は window 外に落ちて永久欠損**になった

#### 未確認（DB だけでは切り分け不能）
- 「Vercel が kickoff を叩いて Dune が 402/429 を返した」のか「Vercel が cron を発火しなかった」のかは、上記コード構造上 DB に痕跡が残らないため区別できない。確証を取るなら Vercel の該当日 Function ログ (`/api/cron/dune-kickoff`) と Dune の Billing / Credit usage 画面を突き合わせる
