# USDKY Tracker - Implementation Plan

最終更新: 2026-05-19
進行状況: 41 / 47 tasks done

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
- [ ] **5.6** デプロイ + 手動 curl で疎通確認 — `Pending` (Vercel デプロイ後に実施)

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
- [ ] **8.3** フロントエンドで積み上げグラフが期待通り描画されることを確認 — `Pending` (localhost:3000 で HTML レンダリング確認済。ユーザーがブラウザで視認確認)
- [ ] **8.4** 自分のウォレット `4QvVC4Cc3UWvFk97VwWWV7AvNg6L7XGXu9GFBKgHPMDD` の `usd_value` が KAST アプリ表示とほぼ一致することを確認 — `Pending` (DB 上 2026-05-19: $8,021.13 / 2026-05-18: $1,770.00。KAST アプリと比較待ち)
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
