# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

RedashbotはSlack Bot for Redash V2で、Redashのクエリ結果やダッシュボードのスクリーンショットをSlackに投稿するボット。HTTP-based Slack Events API（非RTM）を使用。

## Development Commands

```bash
# Install dependencies
npm install

# Start development server (ts-node)
npm start

# Build TypeScript to JavaScript
npm run build

# Docker build and run
docker build -t redashbot .
docker run -p 3000:3000 --env-file .env redashbot
```

## Required Environment Variables

- `SLACK_BOT_TOKEN` - Slack Bot Token
- `SLACK_SIGNING_SECRET` - Slack Signing Secret
- `REDASH_HOST` / `REDASH_API_KEY` - 単一Redashサーバー用
- `REDASH_HOSTS_AND_API_KEYS` - 複数Redashサーバー用 (形式: `host1;token1,host2;token2`)

## Architecture

```
bot.ts                 # エントリーポイント: ExpressReceiver + Bolt App起動
src/
  app.ts               # Bolt Appファクトリ: メッセージハンドラとルーティング登録
  config.ts            # 環境変数から設定読み込み (hosts, browser, sleep等)
  handlers.ts          # メッセージハンドラ (chart/dashboard/table)
  middleware.ts        # カスタムmention()ミドルウェア (reminder対応)
  capture.ts           # Playwrightによるスクリーンショット取得
  redash.ts            # Redash API クライアント (getQuery, getDashboard, getQueryResult)
```

### Message Flow

1. `bot.ts`: ExpressReceiverでSlackイベントを受信
2. `app.ts`: URLパターンに基づきハンドラを振り分け
   - `/queries/{id}#{vizId}` → handleRecordChart (可視化スクリーンショット)
   - `/dashboard/{id}` → handleRecordDashboard (ダッシュボードスクリーンショット)
   - `/queries/{id}#table` → handleRecordTable (テーブル結果をテキスト送信)
3. `middleware.ts`: `mention()`でボットへのメンション付きメッセージのみ処理
4. `capture.ts`: Playwrightでブラウザ起動→スクリーンショット取得→Buffer返却

### Multi-host Support

`config.ts`でREDASH_HOSTS_AND_API_KEYSをパースし、各ホストごとにRedashインスタンスとハンドラを登録。ホストエイリアス対応あり。

## Deployment

### GCE環境

- **プロジェクト**: mikan-develop
- **インスタンス**: redashbot（asia-northeast1-b）
- **スペック**: e2-small（2 vCPU, 2GB RAM）
- **デプロイ先**: `/home/redashbot/`
- **ポートマッピング**: 80 → 3000

### デプロイ手順

```bash
# 1. ファイルをGCEにコピー
gcloud compute scp /path/to/files redashbot:/tmp/ --project mikan-develop --zone asia-northeast1-b

# 2. デプロイ先にコピー
gcloud compute ssh redashbot --project mikan-develop --zone asia-northeast1-b --command "sudo cp /tmp/files /home/redashbot/"

# 3. コンテナ再ビルド・起動
gcloud compute ssh redashbot --project mikan-develop --zone asia-northeast1-b --command "cd /home/redashbot && sudo docker-compose down && sudo docker-compose build --no-cache && sudo docker-compose up -d"

# 4. ログ確認
gcloud compute ssh redashbot --project mikan-develop --zone asia-northeast1-b --command "sudo docker logs redashbot"
```

## 重要な制約事項

### Playwright Dockerイメージの制約

以前のGCEインスタンスがe2-micro（1GB RAM）だったため、新しいPlaywright Dockerイメージでは起動時にNode.jsのスレッド作成に失敗する:

```
pthread_create: Resource temporarily unavailable
uv_thread_create assertion failure
```

**対応**: バージョンを固定したfocalイメージ（例: `mcr.microsoft.com/playwright:v1.46.1-focal`）を使用すること。以下のイメージは動作しない:
- `playwright:v1.57.0-noble`
- `playwright:v1.49.1-jammy`
- `playwright:v1.40.0-jammy`
- `playwright:focal`（タグなし - 最新版に更新されるため不安定）

### Playwrightバージョンの固定

npmパッケージのPlaywrightバージョンは、Dockerイメージに含まれるブラウザバージョンと**完全に一致**させる必要がある:

- **Dockerイメージ**: `playwright:v1.46.1-focal` → Playwright 1.46.1のブラウザ（chromium-1124等）を内蔵
- **npmパッケージ**: `"playwright": "1.46.1"`（`^`なしで固定必須）

**重要**: `playwright:focal`タグは最新バージョンに更新されるため使用禁止。必ずバージョン付きタグ（`v1.46.1-focal`等）を使用すること。

バージョン不整合時のエラー例:

```
browserType.launch: Timeout 180000ms exceeded.
/ms-playwright/chromium-1129/chrome-linux/chrome  ← イメージのバージョン
# npm側が期待するのは chromium-1124
```

```
Executable doesn't exist at /ms-playwright/chromium_headless_shell-1200/...
Looks like Playwright Test or Playwright was just updated to 1.57.0.
Please update docker image as well.
```

### node_modulesの扱い

ローカルでビルドした`node_modules`をサーバーにコピーしないこと。MacとLinuxでネイティブモジュールに互換性がないため、以下のエラーが発生する:

```
Error: Cannot find module './util'
```

**対応**: Dockerfile内で`npm ci`を実行してコンテナ内でインストールする。サーバー上に`node_modules`が残っている場合は削除してから再ビルドする。

## コメント規約

- コードコメントは日本語で記述
- 末尾の句点は不要
