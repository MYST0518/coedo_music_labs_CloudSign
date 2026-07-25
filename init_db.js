const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// データの保存先ディレクトリを環境変数から取得（なければプロジェクトのルート）
const dataDir = process.env.DATA_DIR || __dirname;
const dbPath = path.join(dataDir, 'contracts.db');

// マイグレーションは終わったので、今回はデータベースファイルを削除しない (CREATE TABLE IF NOT EXISTSを使用)

// 必要なディレクトリを作成
const uploadDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const signedDir = path.join(dataDir, 'uploads', 'signed');
if (!fs.existsSync(signedDir)) {
  fs.mkdirSync(signedDir, { recursive: true });
}
const templateDir = path.join(dataDir, 'uploads', 'templates');
if (!fs.existsSync(templateDir)) {
  fs.mkdirSync(templateDir, { recursive: true });
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

  // signers テーブル
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

  // fields テーブル
  db.run(`
    CREATE TABLE IF NOT EXISTS fields (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      signer_id TEXT NOT NULL,
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

  // templates テーブル (テンプレート機能用)
  db.run(`
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // template_fields テーブル (プレフィル差し込み文字や署名枠のメタデータ)
  db.run(`
    CREATE TABLE IF NOT EXISTS template_fields (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      type TEXT NOT NULL, -- 'prefill' (印字), 'signature' (署名枠), 'text' (テキスト枠), 'date' (日付枠)
      signer_role TEXT NOT NULL, -- 'SENDER' (甲), 'RECIPIENT' (乙), 'SYSTEM' (差し込み印字)
      placeholder_name TEXT, -- CSVヘッダーとマッピングする項目名 (例: '乙住所')
      page_number INTEGER NOT NULL,
      x_ratio REAL NOT NULL,
      y_ratio REAL NOT NULL,
      width_ratio REAL NOT NULL,
      height_ratio REAL NOT NULL,
      FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
    )
  `);

  console.log('Database tables initialized successfully with templates schema.');
  db.close();
});
