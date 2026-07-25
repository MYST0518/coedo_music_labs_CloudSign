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

  // 暴音族オムニバス契約書テンプレートの自動登録 (シードデータ)
  const templateId = 'buon-omnibus';
  const now = new Date().toISOString();

  db.get("SELECT id FROM templates WHERE id = ?", [templateId], (err, row) => {
    if (err) {
      console.error(err);
      db.close();
      return;
    }
    if (!row) {
      db.run(
        "INSERT INTO templates (id, title, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [
          templateId,
          "「暴音族オムニバスアルバム -Ｂ.Ｏ.Ｕ.Ｏ.Ｎ-」音楽原盤制作契約書",
          "/uploads/templates/buon_template.pdf",
          now,
          now
        ],
        (err) => {
          if (err) {
            console.error("Failed to seed template:", err);
            db.close();
            return;
          }
          console.log("Seeded 'buon-omnibus' template.");

          // template_fields のインサート
          const fields = [
            // 1ページ目：氏名（prefill）
            { id: 'tf_b_1', type: 'prefill', role: 'SYSTEM', name: '氏名', page: 1, x: 0.69, y: 0.089, w: 0.18, h: 0.02 },
            // 4ページ目：氏名（prefill）
            { id: 'tf_b_2', type: 'prefill', role: 'SYSTEM', name: '氏名', page: 4, x: 0.16, y: 0.885, w: 0.40, h: 0.02 },
            // 4ページ目：住所（prefill）
            { id: 'tf_b_3', type: 'prefill', role: 'SYSTEM', name: '住所', page: 4, x: 0.16, y: 0.855, w: 0.40, h: 0.02 },
            // 4ページ目：甲の署名（SENDER signature）
            { id: 'tf_b_4', type: 'signature', role: 'SENDER', name: null, page: 4, x: 0.10, y: 0.77, w: 0.20, h: 0.06 },
            // 4ページ目：乙の署名（RECIPIENT signature）
            { id: 'tf_b_5', type: 'signature', role: 'RECIPIENT', name: null, page: 4, x: 0.16, y: 0.908, w: 0.20, h: 0.06 }
          ];

          const stmt = db.prepare(`
            INSERT INTO template_fields (id, template_id, type, signer_role, placeholder_name, page_number, x_ratio, y_ratio, width_ratio, height_ratio)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          fields.forEach(f => {
            stmt.run([f.id, templateId, f.type, f.role, f.name, f.page, f.x, f.y, f.w, f.h]);
          });
          stmt.finalize((err) => {
            if (err) console.error(err);
            console.log("Seeded template fields for 'buon-omnibus'.");
            db.close();
          });
        }
      );
    } else {
      db.close();
    }
  });

  console.log('Database tables initialized successfully with templates schema.');
});
