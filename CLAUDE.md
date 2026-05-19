# Project: USDKY Holders Tracker

## 進行管理プロトコル（厳守）

このプロジェクトでは **`plan.md` を進行管理の唯一の真実(source of truth)** とする。

### 必須ルール
1. **作業開始前**: 該当タスクを `Pending` → `In Progress` に更新
2. **作業完了時**: `In Progress` → `Done` に更新し、完了根拠（成果物のパス、コミットハッシュ等）を1行で記載
3. **ブロッカー発生時**: `Blocked` に更新し、理由を記載
4. **ユーザーへの応答の前に** 必ず `plan.md` を更新する
5. **複数タスクをまたぐ場合** も、1タスクずつステータスを順に更新する

### 守るべき設計原則
- DBへの書き込みは必ず `ON CONFLICT` で冪等性を確保する
- Helius RPC呼び出しの間に 100〜200ms の sleep を入れる
- 長時間バッチは進捗ログを `[N / total]` 形式で出力する
- API key / DB接続文字列をコードにハードコードしない（必ず環境変数経由）
- multiplier更新ログのparse方法は Phase 3 で確定するまで実装に入らない

## 参照ドキュメント
- 仕様書: `usdky-tracker-spec.md`
- 進行状況: `plan.md`