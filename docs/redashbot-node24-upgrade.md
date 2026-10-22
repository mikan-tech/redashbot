# RedashBot を Node.js 24（Playwright v1.64.1-noble）へ上げる手順

## 背景

- 2026-10-21 の Node.js セキュリティリリース（v22.23.4 / v24.22.1 / v26.12.1。High 4件、うち1件は Brotli デコーダの RCE）は、EOL の 20.x には修正版が出ない
- 稼働中のイメージは `playwright:v1.46.1-focal` で、中の Node.js は v20.16.0（EOL）
- focal イメージは v1.48 で終わっているため、Node 22/24 にするには jammy か noble に移る必要がある
- 過去に jammy / noble が動かなかったのはメモリ不足ではなく、ホストの Docker 18.09.1 の seccomp が `clone3` を拒否するせいだった。`seccomp=unconfined` を付ければ動くことをホスト上で確認済み（2026-10-22。詳細は AGENTS.md の「Playwright Dockerイメージの制約」）

## 変更内容（このブランチ）

| ファイル | 変更 |
|---|---|
| `Dockerfile` | ベースを `playwright:v1.64.1-noble` にし、`apt-get install --only-upgrade nodejs` で Node.js を最新パッチ（24.22.1 以上）へ上げる |
| `package.json` / `package-lock.json` | `playwright` を `1.64.1` に固定。`@types/node` を `^24.19.2` に、`engines.node` を `>= 24.0` にする |
| `AGENTS.md` | 「e2-micro だったため」という誤った説明を、seccomp/clone3 が原因という内容に直す。compose の例に `security_opt` を追加する |

GCE ホストの `docker-compose.yml` はリポジトリの管理外なので、下の手順で直接編集する。

## 反映手順（GCE: mikan-develop / redashbot）

以下はすべて `gcloud compute ssh redashbot --project mikan-develop --zone asia-northeast1-b` で入ってから実行する。

### 1. 事前確認とロールバック用の退避

```bash
cd /home/redashbot
df -h /                                   # 作業前の空き容量（2026-10-22 時点で 2.4GB）
sudo docker system df
sudo docker tag redashbot_redashbot:latest redashbot_redashbot:node20-backup
sudo cp docker-compose.yml docker-compose.yml.bak-$(date +%Y%m%d)
sudo mkdir -p /home/redashbot-backup-$(date +%Y%m%d)
sudo cp Dockerfile package.json package-lock.json AGENTS.md /home/redashbot-backup-$(date +%Y%m%d)/
```

### 2. ディスクの空きを作る

noble イメージは展開後で約 2GB ある。ビルドの中間レイヤーも含めると 2.4GB では足りないおそれがあるので、使っていないイメージを消す。消してよいか確かめながら1つずつ実行する。

```bash
sudo docker images                         # 一覧を確認
sudo docker image prune                    # タグなし（<none>）のイメージだけを消す。確認プロンプトが出る
sudo docker rmi mcr.microsoft.com/playwright:focal mcr.microsoft.com/playwright:v1.40.0-jammy
df -h /                                    # 4GB 以上空いていれば次へ
```

`redashbot_redashbot:node20-backup` と `playwright:v1.46.1-focal` はロールバックに使うので残す。それでも 4GB に届かないときは作業を止めて相談する。

### 3. ファイルを置き換える（手元の Mac から）

```bash
cd ~/Development/mikan/redashbot
gcloud compute scp Dockerfile package.json package-lock.json AGENTS.md redashbot:/tmp/ --project mikan-develop --zone asia-northeast1-b
gcloud compute ssh redashbot --project mikan-develop --zone asia-northeast1-b --command "sudo cp /tmp/Dockerfile /tmp/package.json /tmp/package-lock.json /tmp/AGENTS.md /home/redashbot/"
```

### 4. docker-compose.yml に seccomp=unconfined を追加する

```bash
sudo vi /home/redashbot/docker-compose.yml
```

`pids_limit` の下に次の2行を足す（インデントは `pids_limit` と揃える）:

```yaml
    security_opt:
      - seccomp=unconfined
```

`docker-compose config` は実行しない（`.env` のトークンが標準出力に出る）。

### 5. 手元でビルドしたイメージを送って入れ替える

ホスト上の `docker-compose build` は失敗する。ビルド中の `RUN` も既定の seccomp で動くため、noble イメージでは `apt-get update` が GPG 検証と後処理スクリプトで落ちる（2026-10-22 に実際に失敗した）。そこで手元の Mac で linux/amd64 のイメージをビルドして送る。送っている間も今のコンテナは止まらない。

```bash
# 手元の Mac で（コミット済みの内容だけを使うため git archive を通す）
cd ~/Development/mikan/redashbot
git archive --format=tar HEAD | docker build --platform linux/amd64 -t redashbot:node24-amd64 -
docker save redashbot:node24-amd64 | gzip -1 | gcloud compute ssh redashbot --project mikan-develop --zone asia-northeast1-b --command "gunzip | sudo docker load"
```

```bash
# GCE ホストで
cd /home/redashbot
sudo docker tag redashbot:node24-amd64 redashbot_redashbot:latest
sudo docker-compose up -d --no-build       # 新しいイメージでコンテナを作り直す（数秒止まる）
```

### 6. 反映を確認する

```bash
sudo docker inspect -f '{{.HostConfig.Init}} {{.HostConfig.PidsLimit}} {{.HostConfig.SecurityOpt}}' redashbot
# → true 200 [seccomp=unconfined]
sudo docker exec redashbot node -v         # → v24.22.1 以上
sudo docker exec redashbot npx playwright --version   # → Version 1.64.1
sudo docker logs --tail 30 redashbot       # 起動ログにエラーが無いこと
sudo docker exec redashbot ps -eo pid,ppid,stat,comm --forest | head   # PID 1 が init であること
```

確認が済んだら、Slack で RedashBot にクエリ（グラフ）とダッシュボードの URL を1件ずつメンションし、スクリーンショットが返ってくるのを見る。`#table` 形式も1件試す。

### 7. 後片付け（1〜2日問題なく動いてから）

```bash
sudo docker rmi redashbot_redashbot:node20-backup mcr.microsoft.com/playwright:v1.46.1-focal redashbot:node24-amd64
sudo docker image prune
```

`playwright:v1.64.1-noble` は、手順5でホスト上のビルドを試したときに pull したもの。新しいイメージとレイヤーを共有しているので、消しても空きはほとんど増えない。

## ロールバック

```bash
cd /home/redashbot
sudo cp /home/redashbot-backup-YYYYMMDD/{Dockerfile,package.json,package-lock.json,AGENTS.md} .
sudo docker tag redashbot_redashbot:node20-backup redashbot_redashbot:latest
sudo docker-compose up -d --no-build
```

`security_opt` は残したままでよい（focal でも問題なく動く）。

## 残るリスクと今後

- `seccomp=unconfined` を付けると、コンテナのシステムコール制限がなくなる。社内向けの bot で、もともと Chromium を `--no-sandbox` で動かしているため許容する
- ホストの OS（Debian 10）は EOL のまま。根本的には Cloud Run への移行（BACK-4947）か、VM の作り直しで解消する
- Node.js のセキュリティリリースが今後出たときは、手元で `--no-cache` を付けて再ビルドし、手順5と同じように送れば、Dockerfile の `--only-upgrade nodejs` が最新パッチを入れる
- ホスト上でビルドできないので、デプロイには手元の Docker（linux/amd64 のビルド）が必要になる

## 反映記録

2026-10-22 に、PR #5 のマージ前に、ブランチ `kikusui/back-8000` の内容でこの手順どおり反映した。

- 空き容量は 2.4GB から 5.0GB に増えた（タグなしイメージと `playwright:v1.40.0-jammy` の削除で 2.6GB 回収）
- ホスト上の `docker-compose build` は `apt-get update` で失敗したため、手元でビルドして送る方法に切り替えた
- 反映後は `node -v` が v24.22.1、Playwright が 1.64.1、`SecurityOpt` が `[seccomp=unconfined]`、PID 1 が `init` になった。起動ログは `⚡️ Bolt app is running @ 3000!`
- ホスト上のコンテナで `src/capture` による実キャプチャを試し、PNG が取れた。`/slack/events` は未署名のリクエストに 401 を返した
