FROM mcr.microsoft.com/playwright:v1.64.1-noble

# イメージ作成時点のNode.jsはセキュリティ修正前のことがあるため、同梱のnodesourceリポジトリから最新パッチへ上げる
RUN apt-get update \
  && apt-get install -y --only-upgrade nodejs \
  && rm -rf /var/lib/apt/lists/* \
  && node -v

COPY package*.json /redashbot/
WORKDIR /redashbot
RUN npm ci --omit=dev

COPY . /redashbot

EXPOSE 3000
CMD ["npm", "start"]
