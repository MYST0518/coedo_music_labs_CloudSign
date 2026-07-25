const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// データの保存先ディレクトリを環境変数から取得（なければプロジェクトのルート）
const dataDir = process.env.DATA_DIR || __dirname;
const dbPath = path.join(dataDir, 'contracts.db');

// 既存のデータベースがある場合は、マイグレーションのため一度削除する
if (fs.existsSync(dbPath)) {
  try {
    fs.unlinkSync(dbPath);
    console.log('Deleted existing contracts.db for migration.');
  } catch (err) {
    console.error('Failed to delete existing database file:', err);
  }
}

// 必要なディレクトリを作成
const uploadDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const signedDir = path.join(dataDir, 'uploads', 'signed');
if (!fs.existsSync(signedDir)) {
  fs.mkdirSync(signedDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
    process.exit(1);
  }
  console.log('Connected to the SQLite database.');
});

db.serialize(() => {
  // contracts テーブル
  db.run(`
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      file_path TEXT NOT NULL,
      signed_file_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // signers テーブル (SENDER = 自分, RECIPIENT = 相手 のroleを追加)
  db.run(`
    CREATE TABLE IF NOT EXISTS signers (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL, -- 'SENDER' または 'RECIPIENT'
      access_token TEXT NOT NULL UNIQUE,
      signed_at TEXT,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
    )
  `);

  // fields テーブル (どの署名者の枠かを識別する signer_id カラムを追加)
  db.run(`
    CREATE TABLE IF NOT EXISTS fields (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      signer_id TEXT NOT NULL, -- signers.id に紐づけ
      type TEXT NOT NULL, -- 'signature', 'text', 'date'
      page_number INTEGER NOT NULL,
      x_ratio REAL NOT NULL,
      y_ratio REAL NOT NULL,
      width_ratio REAL NOT NULL,
      height_ratio REAL NOT NULL,
      value TEXT,
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      FOREIGN KEY (signer_id) REFERENCES signers(id) ON DELETE CASCADE
    )
  `);

  console.log('Database tables initialized successfully with new schema.');
  db.close();
});
