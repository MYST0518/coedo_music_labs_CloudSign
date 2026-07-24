FROM node:18-alpine

# SQLite3 のネイティブビルドに必要なパッケージをインストール
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# データを永続化するマウント先ディレクトリ
ENV DATA_DIR=/data
RUN mkdir -p /data/uploads/signed

EXPOSE 3000

# 起動前にデータベース初期化を実行し、サーバーを立ち上げる
CMD ["sh", "-c", "node init_db.js && node server.js"]
