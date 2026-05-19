# USDKY Holders Tracker - 実装仕様書

## 1. プロジェクト概要

### 目的
KAST発行のSolana stablecoin **USDKY** の保有分布を日次でスナップショット化し、時系列でホルダー別のUSD valueを積み上げ棒グラフで可視化する。

### 最終的なアウトプット
- 縦軸: USD value（USDKY × 現在のmultiplier）
- 横軸: 時系列（日次）
- 積み上げ: ホルダー残高サイズ別バケット
- バックフィル: USDKYローンチ日（2025年6〜7月頃）から現在まで

### 技術スタック
- **Helius RPC**: Solanaオンチェーンデータ取得
- **Vercel**: Cron実行 + APIホスティング + フロントエンド
- **Neon (PostgreSQL)**: スナップショット蓄積
- **TypeScript / Next.js (App Router)**: 実装言語

---

## 2. 重要な前提知識

### USDKYの仕組み（ここを誤解すると数値がズレる）

USDKYはM0 protocolの **ScaledUI extension** （Token2022のrebasing拡張）で実装されている。

- オンチェーン残高（`amount`）= **元本（principal）**
- ユーザー表示残高 = `principal × multiplier`
- `multiplier` はMintアカウントの `scaledUiAmountConfig` extensionに格納
- 短期米国債利回りが蓄積するにつれ、multiplierが上昇する（principalは不変）
- multiplierの更新は**ブリッジイベント駆動**（固定スケジュールではない）

### 主要なオンチェーンアドレス

| 項目 | アドレス |
|------|----------|
| USDKY Mint | `usdkyPPxgV7sfNyKb8eDz66ogPrkRXG3wS2FVb6LLUf` |
| Decimals | 6 |
| M Token (基盤) | `mzerokyEX9TNDoK4o2YZQBDmMzjokAeN6M2g2S3pLJo` |
| M0 Portal | `mzp1q2j5Hr1QuLC3KFBCAUz5aUckT6qyuZKZ3WJnMmY` |
| Token Program | Token2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) |

### 参考時点での状況（2025年5月時点）
- ホルダー数: 約1,089 unique owners
- multiplier: 約 1.03156

---

## 3. データモデル

### Neonスキーマ

```sql
-- 日次snapshot（メインテーブル）
CREATE TABLE usdky_snapshots (
  snapshot_date date    NOT NULL,
  owner         text    NOT NULL,
  principal     numeric NOT NULL,
  multiplier    numeric NOT NULL,
  usd_value     numeric NOT NULL,
  ata_count     int     NOT NULL DEFAULT 1,
  PRIMARY KEY (snapshot_date, owner)
);
CREATE INDEX idx_snapshots_date ON usdky_snapshots (snapshot_date);
CREATE INDEX idx_snapshots_owner ON usdky_snapshots (owner);

-- multiplier履歴（日付 → その日のmultiplier）
CREATE TABLE usdky_multipliers (
  effective_date date        PRIMARY KEY,
  multiplier     numeric     NOT NULL,
  block_time     timestamptz NOT NULL,
  signature      text        NOT NULL
);

-- 生トランザクションログ（再集計用、デバッグ用）
CREATE TABLE usdky_tx_log (
  signature   text        PRIMARY KEY,
  block_time  timestamptz NOT NULL,
  owner       text        NOT NULL,
  delta       numeric     NOT NULL,
  kind        text        NOT NULL  -- 'mint' | 'burn' | 'transfer'
);
CREATE INDEX idx_tx_log_time ON usdky_tx_log (block_time);
CREATE INDEX idx_tx_log_owner ON usdky_tx_log (owner);
```

---

## 4. 環境変数

Vercelプロジェクト + ローカル `.env.local`:

```bash
HELIUS_API_KEY=...                    # Heliusダッシュボードから
DATABASE_URL=postgresql://...         # Neon pooled connection (?pgbouncer=true 推奨)
DATABASE_URL_UNPOOLED=postgresql://... # Neon direct connection (バッチ処理用)
CRON_SECRET=...                       # ランダム32文字
```

---

## 5. 実装タスク（段階的）

## Phase 1: プロジェクト初期化

- [ ] **1.1** Next.js + TypeScript プロジェクト作成 — `Pending`
- [ ] **1.2** 依存パッケージインストール — `Pending`
- [ ] **1.3** Neonプロジェクト作成 + DATABASE_URL取得 — `Pending`
- [ ] **1.4** スキーマをmigrationファイル化してNeonに適用 — `Pending`
- [ ] **1.5** 環境変数セットアップ（local + Vercel） — `Pending`

## Phase 2: Helius RPCクライアント
...
```

各タスクには **ID（X.Y）** と **ステータス** を付ける。ステータスは以下のいずれか:

- `Pending`: 未着手
- `In Progress`: 作業中
- `Done`: 完了（完了根拠を1行で追記）
- `Blocked`: ブロッカーあり（理由を追記）

#### Step 0-4: 初回コミット

`plan.md`, `CLAUDE.md`, `.claude/settings.json` (オプション), `usdky-tracker-spec.md` をリポジトリにコミットする。**ここまで完了したら Phase 1 に進む。**

---

### Phase 1: プロジェクト初期化

- [ ] Next.js (App Router) + TypeScript プロジェクトを作成
- [ ] 依存関係をインストール:
  ```
  @neondatabase/serverless
  drizzle-orm (オプション)
  ```
- [ ] Neonプロジェクトを作成、`DATABASE_URL` を取得
- [ ] 上記のスキーマをNeon上に作成（migrationファイル化推奨）
- [ ] `.env.local` セットアップ + Vercel環境変数登録

### Phase 2: Helius RPCクライアントの実装

- [ ] `lib/helius.ts` を作成
- [ ] 以下のヘルパー関数を実装:
  - `rpc(method, params)`: 汎用JSON-RPC呼び出し
  - `getMultiplier()`: Mintアカウントから現在のmultiplierを取得
  - `getAllTokenAccounts()`: USDKY全token accountをページング取得
  - `getAllSignaturesForMint()`: Mintアカウントの全署名を遡及取得
  - `parseTransaction(sig)`: 単一txから owner deltas + multiplier更新を抽出

### Phase 3: 仕様の事前検証（重要）

実装前に以下を確認すること。**ここをすっ飛ばすとバックフィル全体がやり直しになる。**

- [ ] **multiplier取得方法の検証**
  - `getAccountInfo` でUSDKY Mintを `jsonParsed` で取得
  - `result.value.data.parsed.info.extensions` 配列を確認
  - `extension === 'scaledUiAmountConfig'` のエントリがあるか
  - もし無い場合: ScaledUIではなくCrank実装の可能性。要別途調査。

- [ ] **multiplier更新の検出方法**
  - USDKY Mintの直近の更新トランザクションを `getTransaction` で1〜2件取得
  - `meta.logMessages` と `transaction.message.instructions` の中身を目視確認
  - 確実なparse方法を確定する:
    - 推奨: `parsed.type === 'updateMultiplier'` または `parsed.type === 'amountToUiAmount'` 系の命令を検出
    - 非推奨: ログ文字列の正規表現マッチ（壊れやすい）

- [ ] **`preTokenBalances` / `postTokenBalances` の挙動確認**
  - mint操作時のpre/post差分が想定通りか
  - Token2022のrebasing処理で、ユーザーのprincipal変化が正しく検出できるか

### Phase 4: バックフィルスクリプト

`scripts/backfill.ts` をローカル実行用に作成。

- [ ] 引数: `--from YYYY-MM-DD` （省略時はMintの最初のtx日）
- [ ] **Step 1: 署名取得** — `getSignaturesForAddress` でUSDKY Mintの全署名を取得（`before` でページング）
- [ ] **Step 1.5: 件数確認のポーズ** — 総署名数をログ出力し、続行可否をプロンプト確認（Heliusのcredit消費保護）
- [ ] **Step 2: tx parse** — 各署名を `getTransaction` で取得し、以下を抽出:
  - `preTokenBalances` / `postTokenBalances` から owner別の残高デルタ
  - multiplier更新イベント
- [ ] **Step 3: `usdky_tx_log` への書き込み** — `ON CONFLICT DO NOTHING` で冪等性確保
- [ ] **Step 4: `usdky_multipliers` への書き込み**
- [ ] **Step 5: 日次snapshotの再構成**:
  - 起点日から今日まで日次でループ
  - 各日終了時点までのdeltaを累積 → ownerごとのprincipal算出
  - その日の有効multiplierを `usdky_multipliers` から引いて `usd_value` 計算
  - `usdky_snapshots` にupsert

#### バックフィル実装上の注意

- Helius rate limit対策で各RPC呼び出し間に 100〜200ms sleep
- バッチサイズ大きすぎるとNeonの一括insertが詰まるので、500行ずつくらいに分割
- 進捗ログを `[N/total]` 形式で出すこと（長時間バッチなので可視性重要）
- 途中で落ちても再実行できるよう、`ON CONFLICT` で冪等に

### Phase 5: 日次Cron

`app/api/cron/usdky-snapshot/route.ts` を作成。

- [ ] `Authorization: Bearer ${CRON_SECRET}` ヘッダで認証
- [ ] `export const maxDuration = 60` を設定
- [ ] 処理内容:
  1. 現在のmultiplierを取得
  2. 全token accountを取得（ページング）
  3. owner集約 → principal合計
  4. `usdky_snapshots` に当日分をupsert（unnestで一括）
  5. `usdky_multipliers` に当日のmultiplierをupsert
- [ ] レスポンス: `{ snapshot_date, holders, total_usd, multiplier }` を返す

`vercel.json`:
```json
{
  "crons": [
    { "path": "/api/cron/usdky-snapshot", "schedule": "5 0 * * *" }
  ]
}
```

### Phase 6: 可視化エンドポイント

`app/api/snapshots/route.ts` を作成（積み上げグラフのデータソース）。

- [ ] クエリパラメータ: `bucket=size|rank|cohort` （デフォルト: size）
- [ ] `size` バケット: USD valueを以下で分類
  - `whale_100k+`: 100,000 USD以上
  - `large_10k_100k`: 10,000以上 100,000未満
  - `mid_1k_10k`: 1,000以上 10,000未満
  - `retail_100_1k`: 100以上 1,000未満
  - `dust_lt_100`: 100未満
- [ ] レスポンス形式（Recharts互換）:
  ```json
  [
    { "date": "2025-07-01", "whale_100k+": 0, "large_10k_100k": 0, ... },
    ...
  ]
  ```

### Phase 7: フロントエンド（積み上げ棒グラフ）

`app/page.tsx`:

- [ ] Recharts の `BarChart` + `Bar`（`stackId="a"`）で積み上げ表示
- [ ] バケット切り替えのトグルUI（size / rank / cohort）
- [ ] 現在のmultiplier、総ホルダー数、総USD valueをヘッダに表示
- [ ] レスポンシブ対応（モバイルでも見られるように）

### Phase 8: 動作確認

- [ ] バックフィルをローカル実行 → Neonにデータが入ることを確認
- [ ] Cronを手動で叩いて当日分が入ることを確認:
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" \
    https://YOUR_DOMAIN.vercel.app/api/cron/usdky-snapshot
  ```
- [ ] フロントエンドで積み上げグラフが描画されることを確認
- [ ] Vercel Cronが自動実行されることを翌日確認

---

## 6. 既知の論点 / 要確認事項

### multiplier更新ログのparse方法

ScaledUI extensionのmultiplier更新がどのSolana命令で行われるか、未確定。
- 候補1: Token2022の `amountToUiAmount` 系命令
- 候補2: M0 Portalプログラム経由の専用命令
- **Phase 3で `getTransaction` の生レスポンスを目視して確定すること**

### ユーザー間転送の有無

KAST USDKYは主にmint/burnのみで、ユーザー間転送はほぼ起きない想定。
ただし、外部ウォレットへの引き出しがある場合 `tx_log` に `transfer` kindで記録する必要あり。
parseロジックでは「mint事業者ウォレットからの出庫」と「ユーザー間転送」を区別すること。

### KAST関連ウォレットの識別

バックフィル後、上位ホルダーを目視で確認し、KASTのtreasury / mintingウォレットを特定する。
これらは「ホルダー分布」分析からは除外する選択肢を残すため、別テーブル `kast_known_addresses` を作っておくと拡張性が高い:

```sql
CREATE TABLE kast_known_addresses (
  address  text PRIMARY KEY,
  label    text NOT NULL,  -- 'treasury' | 'minter' | 'bridge' | etc.
  added_at timestamptz DEFAULT now()
);
```

### Helius credit消費の見積もり

バックフィル時の概算:
- `getSignaturesForAddress`: 数回（1000件ずつ）
- `getTransaction`: 全署名分（数千〜数万件の可能性）
- 1コール = 1 credit 換算で、合計1万 credit前後の見積もり
- 無料枠（100K credit/月）内で収まるはずだが、Phase 3で件数を見てから本実行

---

## 7. 拡張アイデア（後続フェーズ）

実装には含めないが、将来的に追加すると価値が出るもの:

- **コホート分析**: 各ownerの初回登場日でcohort化、月別新規流入の可視化
- **multiplier更新タイミングと TVL の相関グラフ**: ブリッジ駆動更新の影響を可視化
- **EthereumのHubPortal側との突合**: 「Solanaにブリッジ済みの$M総量」と「USDKY totalSupply × multiplier」の一致確認
- **Slack/Discord通知**: 大口deposit/withdrawをリアルタイム検知

---

## 8. ディレクトリ構成（推奨）

```
usdky-tracker/
├── .claude/
│   └── settings.json                       # Hooks設定（オプション）
├── app/
│   ├── api/
│   │   ├── cron/usdky-snapshot/route.ts    # 日次Cron
│   │   └── snapshots/route.ts              # 可視化API
│   ├── page.tsx                            # フロントエンド
│   └── layout.tsx
├── lib/
│   ├── helius.ts                           # Helius RPCクライアント
│   ├── db.ts                               # Neonクライアント
│   └── parser.ts                           # tx parse ロジック
├── scripts/
│   └── backfill.ts                         # ローカル実行用バックフィル
├── migrations/
│   └── 001_initial_schema.sql              # 初期スキーマ
├── CLAUDE.md                               # Claude Code向け作業ルール
├── plan.md                                 # 進行管理（毎ターン更新）
├── usdky-tracker-spec.md                   # 本仕様書
├── vercel.json                             # Cron設定
├── .env.local
└── package.json
```

---

## 9. 完了基準

- [ ] `plan.md` の全タスクが `Done` ステータスになっている
- [ ] バックフィルで USDKY ローンチ日〜今日 までのデータが `usdky_snapshots` に存在
- [ ] 日次Cronが Vercel上で2日以上連続で正常実行されている
- [ ] フロントエンドで積み上げ棒グラフが正しく描画される
- [ ] 自分（masanori）のウォレット `4QvVC4Cc3UWvFk97VwWWV7AvNg6L7XGXu9GFBKgHPMDD` を検索したとき、KASTアプリ上の表示残高と `usd_value` がほぼ一致する（小数点以下の丸めは許容）

---

## 10. 参考資料

- M0 公式ドキュメント: https://docs.m0.org/
- M0 Solanaアドレス: https://docs.m0.org/get-started/resources/addresses#solana
- solana-m リポジトリ: https://github.com/m0-foundation/solana-m
- solana-m-extensions リポジトリ: https://github.com/m0-foundation/solana-m-extensions
- Helius DAS API: https://www.helius.dev/docs/das-api
- Neon Serverless Driver: https://neon.tech/docs/serverless/serverless-driver
- Token2022 ScaledUI: https://spl.solana.com/token-2022/extensions#scaled-ui-amount