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

**GCEホスト上では `docker-compose build` できない。** ビルド中の `RUN` も既定のseccompで動くため、noble イメージでは `apt-get` や `npm ci` が失敗する（「Playwright Dockerイメージの制約」を参照）。手元でlinux/amd64のイメージをビルドし、`docker save` / `docker load` でホストへ送る。

```bash
# 1. コミット済みの内容だけでamd64イメージをビルド（未追跡ファイルやローカルのnode_modulesを入れないため git archive を使う）
git archive --format=tar HEAD | docker build --platform linux/amd64 -t redashbot:deploy -

# 2. ファイルをGCEにコピー（Dockerfile等をホスト側の手元と揃えておく）
gcloud compute scp Dockerfile package.json package-lock.json AGENTS.md redashbot:/tmp/ --project mikan-develop --zone asia-northeast1-b
gcloud compute ssh redashbot --project mikan-develop --zone asia-northeast1-b --command "sudo cp /tmp/Dockerfile /tmp/package.json /tmp/package-lock.json /tmp/AGENTS.md /home/redashbot/"

# 3. イメージを送って読み込む（圧縮後で約1GB）
docker save redashbot:deploy | gzip -1 | gcloud compute ssh redashbot --project mikan-develop --zone asia-northeast1-b --command "gunzip | sudo docker load"

# 4. 旧イメージを退避してから差し替え・起動
gcloud compute ssh redashbot --project mikan-develop --zone asia-northeast1-b --command "cd /home/redashbot && sudo docker tag redashbot_redashbot:latest redashbot_redashbot:prev && sudo docker tag redashbot:deploy redashbot_redashbot:latest && sudo docker-compose up -d --no-build"

# 5. ログ確認
gcloud compute ssh redashbot --project mikan-develop --zone asia-northeast1-b --command "sudo docker logs --tail 30 redashbot"
```

戻すときは `sudo docker tag redashbot_redashbot:prev redashbot_redashbot:latest && sudo docker-compose up -d --no-build`。

### リポジトリ管理外のファイル

`docker-compose.yml` と `.env` はこのリポジトリに存在せず、GCEホスト (`/home/redashbot/`) にのみ置かれている。`pids_limit` や `init: true`、`security_opt` などの設定を変更する場合はホスト側を直接編集し、事前にバックアップを取ること。

**`docker-compose config` は実行しないこと** — `.env` のSlack Bot TokenとRedash API Keyが平文で標準出力に出る。設定の反映確認は個別フィールドで行う:

```bash
sudo docker inspect -f '{{.HostConfig.Init}} {{.HostConfig.PidsLimit}} {{.HostConfig.SecurityOpt}}' redashbot
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
    security_opt:
      - seccomp=unconfined  # 「Playwright Dockerイメージの制約」を参照
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

### Playwright Dockerイメージの制約（`seccomp=unconfined` 必須）

GCEホストは Debian 10 (buster) + Docker Engine 18.09.1 と古い。glibc 2.34以上のイメージ（Ubuntu jammy / noble、Debian bookworm 系）を既定のseccompで起動すると、Node.jsが起動時のスレッド作成で落ちる:

```
pthread_create: Resource temporarily unavailable
Assertion `(0) == (uv_thread_create(t.get(), start_thread, this))' failed.
```

原因は、glibc 2.34以降がスレッド作成に使う `clone3` を、古いDocker（20.10.10未満）の既定seccompプロファイルが EPERM で拒否すること。glibcは EPERM のとき `clone` にフォールバックしないため失敗する。以前は「e2-micro（1GB RAM）だったため」と書いていたが誤りで、メモリやPlaywrightのバージョンは関係ない（2026-10-22 にホスト上で検証済み）。

| イメージ | glibc | 既定seccomp | `seccomp=unconfined` |
|---|---|---|---|
| `playwright:v1.46.1-focal` | 2.31 | 起動する | 起動する |
| `playwright:v1.40.0-jammy` | 2.35 | 落ちる | 起動する |
| `node:24-slim` | 2.36 | 落ちる | 起動する |

**対応**: `docker-compose.yml` に `security_opt: [seccomp=unconfined]` を入れる。`docker build` の `RUN` にはこの設定が効かず、ホスト上のビルドでは `apt-get` も失敗するため、イメージは手元でビルドして送る（「デプロイ手順」を参照）。ホストのDockerを20.10.10以上へ更新するか、Cloud Runへ移行すれば不要になる（BACK-4947）。

切り分けるときは、同じイメージを既定と `--security-opt seccomp=unconfined` の両方で起動して比べる:

```bash
sudo docker run --rm IMAGE node -e 'new (require("worker_threads").Worker)("process.exit(0)",{eval:true}).on("exit",()=>console.log("OK",process.version))'
sudo docker run --rm --security-opt seccomp=unconfined IMAGE node -e '...同上...'
```

Playwrightのfocalイメージはv1.48が最後で、中身はNode 20（EOL）だけ。Node 22/24にするには jammy / noble を使うしかない。

### Playwrightバージョンの固定

npmパッケージのPlaywrightバージョンは、Dockerイメージに含まれるブラウザバージョンと**完全に一致**させる必要がある:

- **Dockerイメージ**: `playwright:v1.64.1-noble` → Playwright 1.64.1のブラウザとNode.js 24を内蔵
- **npmパッケージ**: `"playwright": "1.64.1"`（`^`なしで固定必須）

**重要**: `playwright:noble` のようなバージョンなしのタグは最新版に更新されるため使用禁止。必ずバージョン付きタグ（`v1.64.1-noble`等）を使用すること。

イメージ内のNode.jsはイメージ作成時点のパッチ版で止まっている。Node.jsのセキュリティリリースが出たら、Dockerfileの `apt-get install --only-upgrade nodejs` が最新パッチへ上げるので、手元で `--no-cache` を付けて再ビルドし、「デプロイ手順」でホストへ送ればよい。

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
