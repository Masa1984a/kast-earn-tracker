# USDKY Tracker - Implementation Plan

最終更新: 2026-09-05
進行状況: 44 / 47 (Phase 1-8) + Phase 9: 34/36 + Phase 10: 26/27 + Phase 14: 5/5 done
現在の焦点: **Phase 16**（Neon compute 100 CU-hour: 原因調査 = 完了 / 16.2.0 interval 緩和 = 完了・効果測定中 / 16.2.4 → 16.2.1 が次）、**Phase 15**（Gauntlet 欠損のリカバリ済 / 再発防止 3 件が残)

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

---

## Phase 16: Neon compute 枯渇（100 CU-hour 到達）

> 現象: 2026-09-05 に Neon から「project `kast-earn` が月間 100 CU-hour の 100% を消費、compute が suspend されうる」というメールを受信。
> 結論: **`dune-poll` cron が `*/10 * * * *` = 24時間365日 10 分おきに Neon を叩いており、Neon Free の autosuspend (5 分) と噛み合って compute が常時稼働の約半分の時間起きっぱなしになっている**。Phase 15 の Dune クレジット枯渇と根は同じ「必要な時間帯を超えて回り続けるポーリング」。

### 16.1 原因調査
- [x] **16.1** Neon CU-hour 消費の原因特定 — `Done` (根拠は下記「Phase 16 調査結果」。`vercel.json` の `dune-poll` = `*/10 * * * *` / `app/api/cron/dune-poll/route.ts:26-40` が job 有無に関わらず毎回 UPDATE + SELECT を発行)

### 16.2 対策
- [x] **16.2.0** `dune-poll` の interval を緩める（`*/10` → `*/30`、24h 維持）— `Done` (`vercel.json`: `*/10 * * * *` → `*/30 * * * *`。**144 回/日 → 48 回/日**、稼働率 50% → 約 17%、poll 由来 約 90 → **約 30 CU-h/月** の見込み。あわせて `scripts/backfill-gauntlet-range.ts:4,107` の「10 分毎」表記を「30 分毎」へ更新。`npx tsc --noEmit` 通過)
  - 実害の確認: 日次フローの有効ポーリング窓は `STALE_HOURS = 1` で決まっており **interval では変わらない**（23:30 kickoff に対し 00:00 / 00:30 の 2 回で拾い、01:00 の stale UPDATE で打ち切り。`*/10` でも打ち切りは 00:40 で同じ ~1h）。差分は ①ingest 遅延が最大 10 分 → 30 分 ②Dune API の一過性エラー時のリトライ機会が 5 回 → 1 回 の 2 点のみ
  - 未着手の副作用: 手動 backfill（`scripts/backfill-gauntlet-range.ts` / `POST /api/admin/trigger-gauntlet-backfill`）は引き続き dune-poll 依存のまま。24h 稼働は維持したので**現時点で壊れてはいない**が、16.2.1 で窓を絞る前に 16.2.4 が必要という関係は変わらない
- [ ] **16.2.1** `dune-poll` の schedule を kickoff 直後の窓に限定（`*/10 * * * *` → `*/10 23,0,1 * * *` 等）— `Pending`（144 回/日 → 18 回/日 = 約 87% 削減、約 11 CU-h/月。`STALE_HOURS = 1` なので日次フロー = 23:30 kickoff には 23:00-01:59 で十分。**ただし 16.2.4 が前提**）
  - ⚠️ **前回の記載は誤り**: 「手動 backfill の取り込みは `scripts/wait-dune-jobs.ts` で代替できる」は誤。同スクリプトは `dune_jobs.status` を眺めるだけで **ingest は一切しない**（`scripts/wait-dune-jobs.ts:31-45` は SELECT のみ）。`scripts/backfill-gauntlet-range.ts` のヘッダも `app/api/admin/trigger-gauntlet-backfill/route.ts` も、明示的に「results の取得と ingest は本番の `dune-poll` cron に任せる」設計
- [ ] **16.2.4** 手動 backfill を自己完結させる（`scripts/backfill-gauntlet-range.ts` に kickoff 後の poll + `ingestJobResults()` 呼び出しを追加、または `wait-dune-jobs.ts` を ingest 込みに拡張）— `Pending`（**16.2.1 の前提条件**。理由: `dune-poll` は stale UPDATE を SELECT より前に実行するため（`app/api/cron/dune-poll/route.ts:26-40`）、窓を夜間に絞ると昼に kickoff した backfill job は 1 時間で stale 判定され、**窓が開いた時には `failed` にされて results が捨てられる**。snapshots クエリは 1 回 58.5 credits なので Dune クレジットも無駄になる）
- [ ] **16.2.2** `dune-poll` で stale UPDATE を SELECT の後ろに移し、`executing` が 0 件なら UPDATE を発行しない — `Pending`（クエリ数半減。ただし compute の起床自体は防げないので効果は限定的）
- [ ] **16.2.3** 読み取り API (`/api/summary` `/api/snapshots` `/api/holders` `/api/share-prices`) の `force-dynamic` を見直し、日次更新のデータに合わせて `revalidate` / `Cache-Control` を入れる — `Pending`（現状は画面を開くたびに Neon が起床し 5 分課金される）

### Phase 16 調査結果（2026-09-05 実施）

#### 確定事実（コード / 設定）
1. `vercel.json`: `dune-poll` は **`*/10 * * * *` = 1 日 144 回**。`2824495` (2026-05-20, Phase 9) で追加されて以来ずっとこの設定
2. `app/api/cron/dune-poll/route.ts:26-40`: 認証通過後、**`executing` job の有無に関わらず** stale UPDATE と SELECT の 2 本を必ず実行する。`jobs.length === 0` の early return は SELECT の**後**にあるので、DB アクセス自体は毎回発生する
3. 実際に job が存在するのは `dune-kickoff` (23:30 UTC) 直後のみ。`STALE_HOURS = 1` なので **1 日のうち有効なポーリングは高々 6〜12 回**、残り 130 回超は「no executing jobs」で空振りしながら compute を起こしている
4. `lib/db.ts` は `neon()` (HTTP one-shot driver) なので常時接続は張らない。→ 常駐接続ではなく **10 分おきの起床** が原因

#### CU-hour 収支の見積り
- Neon Free の scale-to-zero は **アイドル 5 分**、最小 **0.25 CU**
- 10 分間隔クエリ → 起床 → 5 分アイドルで suspend → 5 分停止 → 次のクエリ、の繰り返し = **稼働率 約 50%**
- 24h × 50% = 12 compute-hour/day × 0.25 CU = **3 CU-hour/day → 30 日で約 90 CU-hour**
- ここに `usdky-snapshot` / `dune-kickoff` の日次 2 本と、`force-dynamic` な読み取り API へのダッシュボードアクセス（1 回のアクセスごとに 5 分課金）が上積み → **100 CU-hour 到達と整合**
- 16.2.1 適用後の試算: 18 回/日 × 5 分 = 1.5 h/day × 0.25 CU = **約 0.4 CU-hour/day → 30 日で約 11 CU-hour**（枠の約 11%）

---

## Phase 17: Gauntlet グラフ欠損の再発（2026-08-21 以降）

> 現象: ダッシュボードの Gauntlet Alpha が 2026-08-21 のスナップショットで止まり、以降のバーとホルダー線が途切れている（USDKY 側は 2026-09-10 まで正常）。Phase 15 と同じ「Dune 側だけ沈黙」パターンの再発。
> 前提: Dune のクレジットリセットは毎月 12 日（Phase 15 調査結果 4）。本日 2026-09-12 はリセット直後にあたる。

### 17.1 現状把握
- [x] **17.1** 欠損レンジと `dune_jobs` の履歴を Neon 実データで確定 — `Done` (`scripts/diag-gauntlet-gap.ts` に `--from/--to` を追加して実行。結果は下記「Phase 17 調査結果」。**欠損は 08-27..09-11 の 16 日だけでなく、08-22 / 08-26 の部分欠損と 08-24..08-26 の share_price=1 汚染を含む**)

### 17.2 リカバリ
- [x] **17.2.1** 手動 backfill を self-contained 化（= Phase 16.2.4）— `Done` (`scripts/backfill-gauntlet-range.ts` を全面改訂: kickoff → Dune 完了待ち → `getAllExecutionResults()` でページング取得 → 1 万行ずつ `ingestJobResults()` を進捗ログ付きで実行 → `dune_jobs` を completed/failed に更新、までローカルで完走する。job 行は `status='local'` で作るので `dune-poll` が二重取得しない。`--no-wait`（従来動作）/ `--execution-id`（kickoff 済み execution の取り込みのみ・クレジット消費ゼロ）/ `--kinds kast_wallets` / `--timeout-min` を追加。`lib/dune.ts` に `getAllExecutionResults()` を追加。`npx tsc --noEmit` 通過 / lint 追加エラーなし)
- [x] **17.2.2** snapshots 2026-08-22 .. 09-11 を再取得して埋め直す — `Done` (execution `01M2AR7TE04ZK9YTCTR0ZWDZ1Z` は 6.5 分で完了し 160,326 行を取得。1 回目の ingest は Neon 満杯で全滅（Phase 18）→ 容量回収後に `--execution-id` で **再実行なし = 追加クレジットゼロ**で取り込み直し、job #259 で 160,326 行 completed)
- [x] **17.2.3** `kast_base_wallets` を再取得 — `Done` (job #258 / 5,999 行。08-23 時点の 5,758 件から +241 件)
- [x] **17.2.5** ingest の日付ずれバグ修正 — `Done` (`lib/ingest.ts:dateKey()` が Postgres の `date` 列を `toISOString()` で切っていたため、**JST のローカル実行だと 1 日前にずれる**（Vercel は UTC なので今まで表面化しなかった）。結果 priceMap のキーが 1 日ずれ、チャンク末尾の日は price が引けず `1.0` にフォールバックして TVL が 48M / 52M で振動した。ローカル日付要素から組み立てる形に修正 + `scripts/repair-gauntlet-prices.ts` を新規作成して `gauntlet_share_prices` から `share_price` / `usd_value` を再突合（160,326 行、Dune 非使用）)
- [x] **17.2.4** リカバリ後の検証 — `Done` (`gauntlet_snapshots` = 2025-06-05 .. 2026-09-11 の **464 日で欠損 0** / 1,457,522 行。holders 7,479 (08-21) → 7,489 → … → 7,784 (09-11) と単調増加、TVL も 52.67M → 52.59M → … → 51.11M と滑らか、全 21 日で `share_price` が `gauntlet_share_prices` と一致。画面が使う KAST filter 経路（`INNER JOIN kast_base_wallets`）も 5,697 → 5,927 holders で連続（`scripts/diag-gauntlet-gap.ts` に「8b. KAST filter 経路」を追加して検証）。残る欠損は 09-12 のみ = 今夜 23:30 UTC の cron 待ち)
- [ ] **17.2.6** `usdky_snapshots` の 2026-09-11 欠損 — `Blocked`（Neon 満杯で当日の cron が書けなかったぶん。USDKY の日次 cron は Helius から**その時点の**全 token account を読む方式なので、後追いでは復元できない。`usdky_tx_log` は 2026-05-19 で止まっており（初回 backfill のまま日次更新していない）、tx から再構成するには `scripts/backfill.ts` の全期間 backfill = Helius クレジットと追加のディスク容量が要る。1 日の穴を埋めるためにやるかはユーザー判断）

### 17.3 再発防止（コードは適用済 / デプロイは未）
- [x] **17.3.1** `dune-poll` の stale UPDATE を SELECT の後ろへ移動 + `STALE_HOURS` 1 → 2（= Phase 16.2.2 も同時に解消）— `Done` (`app/api/cron/dune-poll/route.ts`: 「拾う前に殺す」順序を解消し、`executing` が 0 件なら UPDATE を発行しない形になった)
- [x] **17.3.2** `dune-poll` に取り込みサイズのガードを追加 — `Done` (`MAX_CRON_INGEST_ROWS = 80_000`。`getExecutionStatus` の `result_metadata.total_row_count` を見て超過なら **部分 ingest せず** `failed` にし、`--execution-id ...` での手動復旧コマンドを `error_message` に残す。08-22 / 08-26 のような部分欠損を作らない)
- [x] **17.3.3** `dune-kickoff` の window を `MAX_WINDOW_DAYS = 8`（= 9 日ぶん）で頭打ちに — `Done` (`resolveStartDate()`。30 日の欠損に対して 30 日 window を投げても poll が取り込めず全損するので、1 晩 9 日ずつ複数晩かけて自己修復させる)
- [x] **17.3.4** kickoff 拒否時に `dune_jobs` へ `failed` 行を残す（= Phase 15.3.2）— `Done` (`kickoffJob()` の `executeQuery` を try/catch し `kickoff rejected: ...` を記録。08-24..09-09 の「行ゼロの 17 日間」が今後は DB から見える)
- [x] **17.3.5** `vercel.json` の `dune-poll` を夜間窓に限定（= Phase 16.2.1）— `Done` (`*/30 * * * *` → `*/10 23,0,1,2 * * *`。48 回/日 → 24 回/日 で Neon CU も削減、かつ 23:30 kickoff に対し 10 分刻み × `STALE_HOURS=2` で実効窓 30 分 → 120 分に回復。16.2.1 の前提だった 16.2.4 は 17.2.1 で完了済)
- [ ] **17.3.6** 欠損検知アラート（= Phase 15.3.4）— `Pending`（`gauntlet_snapshots` に前日行が無い / `dune_jobs` に failed がある場合に通知。現状は画面を見るまで気づけない）
- [ ] **17.3.7** `POST /api/admin/trigger-gauntlet-backfill` は依然 `dune-poll` 依存 — `Pending`（17.3.5 で poll が夜間のみになったため、昼に叩くと最大 数時間 待たされる。手動復旧は `scripts/backfill-gauntlet-range.ts` を正とし、admin route は将来 `status='local'` + 自前 ingest へ寄せるか撤去する）

### Phase 17 調査結果（2026-09-12 実施）

`npx tsx --env-file=.env.local scripts/diag-gauntlet-gap.ts --from 2026-08-15 --to 2026-09-12` の実データより:

1. **`gauntlet_share_prices` は 09-11 まで欠損 0**（09-12 は当日ぶんで未取得なので正常）。壊れているのは `gauntlet_snapshots` だけ
2. `gauntlet_snapshots` の実際の被害は 3 種類:
   - **完全欠損 16 日**: 2026-08-27 .. 09-11
   - **部分欠損 2 日**: 08-22 = 2,913 holders / 08-26 = 4,963 holders（正常日は約 7,500）
   - **share_price 汚染 3 日**: 08-24 / 08-25 / 08-26 が `share_price = 1`（`ingestGauntletSnapshots` は price 行が無い日を `1.0` で埋める）→ tvl が 52M ではなく 48M で記録
3. `dune_jobs` の履歴:
   - 08-22 / 08-23 の `gauntlet_daily` が `Stale: exceeded 1 hour(s)` で failed（08-23 は kast wallets も `QUERY_STATE_FAILED`）
   - **08-24 .. 09-09 の 17 日間は行が 1 件も無い** = Phase 15 と同じ「Dune が kickoff を拒否 → `executeQuery` が throw → INSERT に到達せず痕跡ゼロ」（15.3.2 が未着手のため再発）
   - 09-10 / 09-11 は 3 job とも行が作られたが**全部 stale で failed**、`rows_count` は null
4. **`dune-poll` の 60 秒制約が部分欠損の主因**: `maxDuration = 60` の中で job を逐次処理し、`getExecutionResults()` で 15 万行級を取得 → `ingestJobResults()` が 500 行ずつ Neon に往復する。途中で関数が殺されると **行だけ部分コミットされ、`dune_jobs` は `executing` のまま**残る（08-26 が 4,963 行で止まっているのがその痕跡）。09-10 の job #251 は window 08-23..09-10 = 約 13 万行で、これが 08-24..08-26 を書いた
5. **`*/30` 化（16.2.0）で stale の実効窓が半減した**: kickoff 23:30 に対しポーリングは 00:00 と 00:30 の 2 回だけ。00:30 の実行では stale UPDATE が SELECT より先に走り、`started_at + 1h` を 9 秒超過して **拾う前に failed に落とす**。`*/10` 時代は 00:30 の回で間に合っていた（実効窓 60 分 → 30 分）。09-10 / 09-11 の全 job が stale なのはこれと整合。→ plan 16.2.0 に書いた「差分は ingest 遅延とリトライ回数だけ」は**誤り**
6. Dune のクレジット復帰は 09-10（kickoff が受理され始めた日）。plan 15 の「毎月 12 日リセット」は 09 月では成り立っていない


---

## Phase 18: Neon ストレージ 512 MB 上限到達（Phase 17 リカバリの真のブロッカー）

> 現象: Phase 17 のリカバリ ingest が `NeonDbError: could not extend file because project size limit (512 MB) has been exceeded` (SQLSTATE 53100) で失敗。
> 結論: **Neon Free の 512 MB を使い切って DB が書き込み不能になっていた**。Gauntlet が Dune 都合で止まっていたのとは別に、**USDKY 側も 2026-09-11 以降スナップショットが取れていない**（`usdky_snapshots` の最終日が 09-10）のはこれが理由。つまり画面の「Gauntlet が途切れている」は Dune クレジット枯渇 + poll の 60 秒制約 + **DB 満杯** の 3 段重ね。

### 18.1 現状把握
- [x] **18.1** ストレージ内訳の計測 — `Done` (`scripts/diag-neon-size.ts` を新規作成。計測時 **490 MB / 512 MB (95.6%)**。内訳は下記)

### 18.2 即時の容量回収（データ削除なし）
- [x] **18.2.1** 冗長インデックスの削除 — `Done` (`migrations/006_reclaim_space.sql`: `idx_gauntlet_date` (48 MB) は PK `(snapshot_date, holder)` の先頭列と重複で完全に冗長。ほか `idx_kast_wallets_funded` (idx_scan=0) / `idx_tx_log_time` (idx_scan=2) も削除。復元 SQL はコメントに明記)
- [x] **18.2.2** VACUUM で dead tuple を回収可能にする — `Done` (`scripts/diag-neon-size.ts --vacuum`。`gauntlet_snapshots` に dead 232,839 行が滞留していた = 最終 autovacuum が 08-21。**VACUUM FULL は使わない**（一時的に倍の容量が要るため上限到達時に走らせてはいけない）)
- 結果: **490 MB → 441 MB**（空き 71 MB + heap 内に再利用可能な約 30 MB）
- リカバリ完了後の実測: **457 MB / 512 MB (89%)**。空き 55 MB / 増加ペース 約 2.5 MB/日 → **残り約 3 週間**

### 18.3 構造対策（未決定・ユーザー判断が必要）
- [x] **18.3** 増加ペースへの恒久対策 — `Done`（方針決定: 「保持期間 + 日次集計」を採用 → 実装は Phase 19）
  - 現状 `gauntlet_snapshots` は **368 MB / 1,327,608 行**（heap 196 MB + index 172 MB）で、**1 日あたり約 7,600 行 ≒ 2.5 MB**（heap + PK index + holder index）。**約 75 MB/月**で増える
  - つまり今回の回収分だけでは **2〜3 週間でまた上限**に当たる
  - 候補:
    1. **明細の保持期間 + 日次集計テーブルへのロールアップ** — グラフが必要とするのは日次の 5 バケット合計と holders 数だけ。明細は直近 N 日だけ残す。約 270 MB を空けられ、増加も頭打ちにできる。代償: ウォレット個別検索が N 日より前を返せなくなる
    2. **Neon プランのアップグレード** — コード変更ゼロ / 有料
    3. **行あたりのサイズ削減**（`holder` を text(42) → bytea(20)、`chain` 列の削除）— 3〜4 割減。増加ペース自体は変わらない

### Phase 18 調査結果（2026-09-12 実施）

| テーブル | total | heap | index | rows |
|---|---|---|---|---|
| `gauntlet_snapshots` | 416 MB → 368 MB | 196 MB | 220 MB → 172 MB | 1,327,608 |
| `usdky_snapshots` | 60 MB | 29 MB | 31 MB | 264,658 |
| その他合計 | 約 6 MB | | | |

- **index が heap より大きい**のが特徴。`gauntlet_snapshots_pkey` だけで 157 MB（`(date, text(42))` の複合 PK）
- `idx_gauntlet_date` は 48 MB を使いながら PK の先頭列と完全に重複していた（scans 7,944 はすべて PK で代替可能）
- 認証系の残骸テーブル（`user` / `session` / `account` / `organization` 等）も存在するが合計 8 KB 程度で無害


---

## Phase 19: Gauntlet 明細の保持期間 + 日次集計（Phase 18.3 の実装）

> 方針: グラフ / サマリが必要とするのは「日 × スコープ」の集計値だけ。集計を永続化しておけば、
> ホルダー明細 (`gauntlet_snapshots`) を保持期間で削っても全期間の推移を描ける。
> 明細が要るのは ①個別ウォレット検索 ②`/api/holders`（最新日と前日）の 2 つだけ。

### 19.1 集計テーブル
- [x] **19.1.1** `gauntlet_daily_rollup` を作成 — `Done` (`migrations/007_gauntlet_daily_rollup.sql`。PK `(snapshot_date, scope)` / `scope` は `'all'` \| `'kast'` の CHECK 付き。holders / total_usd / 5 バケット / share_price を保持)
- [x] **19.1.2** `lib/rollup.ts:refreshGauntletRollup()` — `Done`（指定日を明細から丸ごと再計算する冪等処理。ingest の途中で何度呼んでも最終値は同じ）
- [x] **19.1.3** ingest への組み込み — `Done` (`lib/ingest.ts`: snapshots ingest 後と price ingest 後（`usd_value` が動くため）に集計を作り直す)
- [x] **19.1.4** 全期間の集計を生成 — `Done` (`scripts/backfill-gauntlet-rollup.ts` で 464 日 → **712 行**（`all` 464 + `kast` 248。初期の 216 日は KAST ウォレットが 1 件も居ないので `kast` 行は作られない）。`--verify` で明細との holders / total_usd 一致を確認)

### 19.2 読み取り側の切り替え
- [x] **19.2.1** `/api/snapshots` を集計テーブル経由に — `Done`（`service=gauntlet` のバケット集計と複合クエリの gauntlet 側。**ウォレット指定があるときだけ明細を読む**）
- [x] **19.2.2** `/api/summary` を集計テーブル経由に — `Done`（あわせて `snapshot_at` の集計元を `job_kind = 'gauntlet_daily'` → `IN ('gauntlet_daily', 'gauntlet_backfill')` に変更。手動リカバリも「最終取得日時」に反映される）
- [x] **19.2.3** 実 API での検証 — `Done`（`npm run dev` + curl。kast_only の holders 5,903 / 5,913 / 5,927、TVL 3,466,106 / 3,331,507 / 2,848,862 が明細直読みの値と完全一致）

### 19.3 明細のパージ（**デプロイ後でないと実行してはいけない**）
- [ ] **19.3.1** `scripts/purge-gauntlet-detail.ts` で古い明細を削除 — `Blocked`
  - ⚠️ **順序の制約**: 本番にデプロイされている読み取り API はまだ明細を直読みしている。**19.2 をデプロイする前にパージすると、本番のグラフから過去分が消える**
  - dry-run 実測（`--keep-days 90`）: 削除対象 **373 日 / 802,936 行**（明細の 55%）
  - 安全策は実装済: 集計行が無い日は消さない / `--yes` が無いと消さない / 1 日ずつ削除して 30 日ごとに VACUUM
  - 削除しても Neon の使用量はすぐには減らない（空きページとして再利用される）。**増加を止めるのが目的**
- [ ] **19.3.2** パージの自動化 — `Pending`（日次 cron に「保持期間より古い 1 日を消す」を足せば横ばいを維持できる。19.3.1 を手動で回してから）

### 19.4 既知の挙動変更
- `kast` スコープの集計は**集計した時点の `kast_base_wallets`** で確定する。従来は読むたびに INNER JOIN していたので、KAST ウォレットが新しく見つかると過去日の数字も後から増えていた。今後は ingest で触れた日（直近 8 日程度）だけ追随し、それより古い日は固定される
- ウォレット個別検索の Gauntlet 履歴は、パージ後は保持期間より前を返さなくなる（UI に注記を出すかは未対応）

### Phase 19 メモ: 2026-09-12 夜の cron（未デプロイ状態での実測）
- `#260 gauntlet_daily` / `#261 kast_base_wallets_daily` が **また `Stale: exceeded 1 hour(s)` で失敗**（09-12 分の Gauntlet 明細が欠測）
- `#262 gauntlet_price` だけ 16 秒で完了したので成功
- → Phase 17.3 の修正（stale 窓 30 分 → 120 分、poll 順序、`*/10 23,0,1,2`）が**デプロイされるまで毎晩同じ失敗が続き、1 回あたり 58.5 credits を捨て続ける**
- デプロイすれば `dune-kickoff` の動的 lookback（最大 9 日）が 09-12 の欠損を翌晩に自動で埋める。手動 backfill でクレジットを使う必要はない


---

## Phase 20: 欠損 2 件の補正（2026-09-13 実施）

> デプロイ後に残っていた `usdky_snapshots` 2026-09-11 と `gauntlet_snapshots` 2026-09-12 の穴を埋めた。

### 20.1 Gauntlet 2026-09-12
- [x] **20.1** 手動 backfill で復元 — `Done` (`scripts/backfill-gauntlet-range.ts --from 2026-09-12 --to 2026-09-12 --kinds snapshots`。job #263 / 7,795 行。price は #262 が成功済みだったので snapshots のみ。今夜の cron でも無料で埋まる状況だったが、即時反映を優先してユーザー判断で 1 execution 分 58.5 credits を使用)

### 20.2 USDKY 2026-09-11
- [x] **20.2.1** 再構成スクリプトの作成 — `Done` (`scripts/repair-usdky-day.ts`。日次 cron は Helius から「その時点の」token account を読む方式で後追い取得ができないため、**前日スナップショット + (前日 cron 時刻, 対象日 cron 時刻] の owner 差分**で再構成する。境界時刻は `usdky_multipliers.block_time`（cron が `NOW()` で打つ）を使い、行が無い日は実測の 23:00:45 UTC を採用)
- [x] **20.2.2** 手法の検証 — `Done`（`--verify`: **09-10 + 差分 → 09-12 を再構成して実データと突合し、2,712 owner 全部が完全一致**。加えて ①境界 ±2 分に入る tx が 0 件 = 境界のずれは結果に影響しない ②multiplier も「境界以前の最新 `updateMultiplier` イベントを採用」というルールで 09-12 の実測値 1.042885360446 を正しく再現できることを確認）
- [x] **20.2.3** 書き込み — `Done`（2026-09-11 = **2,701 owner / total_usd 2,896,521.70 / multiplier 1.042790351569**。前後の 09-10 (2,690 / 2,896,256.86) と 09-12 (2,712 / 2,896,785.60) の間に収まる。`usdky_multipliers` には `signature = 'repair-2026-09-11'` で cron 由来と区別できる印を残した）

### 20.3 補正後の状態
- 本番 API 実測（デプロイ済みの集計テーブル経由）: 09-09 .. 09-12 の 4 日とも `usdky` / `gauntlet` 両方が埋まり null なし
- 残るのは 09-13（当日）のみ = 今夜の cron 待ち
- **Phase 19.3.1 のパージがデプロイ完了により実行可能になった**（未実行）
