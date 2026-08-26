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
- `CAPTURE_CONCURRENCY` - キャプチャの同時実行数 (省略時は2)。詳細は「キャプチャの同時実行数」を参照

## Architecture

```
bot.ts                 # エントリーポイント: ExpressReceiver + Bolt App起動
src/
  app.ts               # Bolt Appファクトリ: メッセージハンドラとルーティング登録
  config.ts            # 環境変数から設定読み込み (hosts, browser, sleep等)
  handlers.ts          # メッセージハンドラ (chart/dashboard/table)
  middleware.ts        # カスタムmention()ミドルウェア (reminder対応)
  capture.ts           # Playwrightによるスクリーンショット取得 (同時実行数を制限)
  semaphore.ts         # 同時実行数を制限するセマフォ
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

### リポジトリ管理外のファイル

`docker-compose.yml` と `.env` はこのリポジトリに存在せず、GCEホスト (`/home/redashbot/`) にのみ置かれている。`pids_limit` や `init: true` などの設定を変更する場合はホスト側を直接編集し、事前にバックアップを取ること。

**`docker-compose config` は実行しないこと** — `.env` のSlack Bot TokenとRedash API Keyが平文で標準出力に出る。設定の反映確認は個別フィールドで行う:

```bash
sudo docker inspect -f '{{.HostConfig.Init}} {{.HostConfig.PidsLimit}}' redashbot
```

## 重要な制約事項

### ゾンビプロセスの回収（`init: true` 必須）

コンテナのPID 1が `npm start` だと、終了したChromiumの子プロセスが `<defunct>`（ゾンビ）としてPIDテーブルに残り続ける。npmは子プロセスを `wait()` しないため誰も回収しない。ゾンビは1件ずつPIDを消費し自然には減らないので、`pids_limit` に到達すると新規プロセスを起動できず、コンテナが `Up` のまま応答不能になる。

**`docker-compose.yml` に `init: true` を必ず入れる**（tiniがPID 1になりゾンビを回収する）:

```yaml
services:
  redashbot:
    init: true
    pids_limit: 200
```

適用されていればPID 1が `init` になる:

```
    1     0 Ss   init
    6     1 Sl   npm start
```

`capture()` の `try/finally` による `browser.close()` ではこの問題は直らない。`close()` は「プロセスを終了させる」だけで、終了後のゾンビを回収するのは親プロセスの責務であり、別レイヤの問題である。実際に `close()` を全経路で呼ぶ修正を入れた後も再発した。

診断は `docker exec redashbot ps -eo pid,ppid,stat,comm --forest` で `Z`(defunct) の有無とPID 1の正体を見る。CPU・メモリは当てにならない（PIDが枯渇していてもCPU 0%・メモリに余裕があることがある）。

### キャプチャの同時実行数

Slackのリマインダーで複数のクエリが一斉に投稿されると、ハンドラが並行して動きChromiumが同時に何個も起動する。Chromiumは1インスタンスあたり多数のプロセス・スレッドを生成するため、瞬間的にPID上限へ到達し `pthread_create: Resource temporarily unavailable` や `spawn ... EAGAIN` でクラッシュする。

`src/semaphore.ts` で同時実行数を制限しており、既定値は2。`CAPTURE_CONCURRENCY` で変更できるが、上げる場合は `pids_limit` とあわせて検討すること。

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
