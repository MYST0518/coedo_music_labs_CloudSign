const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

// データの保存先ディレクトリを環境変数から取得（なければプロジェクトのルート）
const dataDir = process.env.DATA_DIR || __dirname;
const dbPath = path.join(dataDir, 'contracts.db');
const db = new sqlite3.Database(dbPath);

// データベース処理のプロミス化ユーティリティ
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    if (err) reject(err);
    else resolve(this);
  });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

// Expressの設定
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 静的ファイルの配信設定
app.use(express.static(path.join(__dirname, 'public')));
// アップロードされたPDFファイルを配信するためのパス設定（DATA_DIR基準）
app.use('/uploads', express.static(path.join(dataDir, 'uploads')));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Multerの設定 (アップロード先を DATA_DIR/uploads に変更)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = path.join(dataDir, 'uploads');
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'contract-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('PDFファイルのみアップロード可能です。'), false);
    }
  }
});

// -------------------------------------------------------------
// 画面ルート
// -------------------------------------------------------------

// 1. ダッシュボード (契約一覧)
app.get('/', async (req, res) => {
  try {
    const contracts = await dbAll(`
      SELECT c.*, s.name as signer_name, s.email as signer_email, s.access_token
      FROM contracts c
      LEFT JOIN signers s ON c.id = s.contract_id
      ORDER BY c.created_at DESC
    `);
    res.render('index', { contracts });
  } catch (err) {
    console.error(err);
    res.status(500).send('サーバーエラーが発生しました。');
  }
});

// 2. 契約書作成・編集画面
app.get('/contracts/edit/:id', async (req, res) => {
  try {
    const contract = await dbGet('SELECT * FROM contracts WHERE id = ?', [req.params.id]);
    if (!contract) {
      return res.status(404).send('契約書が見つかりません。');
    }
    if (contract.status !== 'DRAFT') {
      return res.redirect(`/contracts/detail/${contract.id}`);
    }
    res.render('edit', { contract });
  } catch (err) {
    console.error(err);
    res.status(500).send('サーバーエラーが発生しました。');
  }
});

// 3. 契約書詳細画面
app.get('/contracts/detail/:id', async (req, res) => {
  try {
    const contract = await dbGet('SELECT * FROM contracts WHERE id = ?', [req.params.id]);
    if (!contract) {
      return res.status(404).send('契約書が見つかりません。');
    }
    const signer = await dbGet('SELECT * FROM signers WHERE contract_id = ?', [contract.id]);
    const fields = await dbAll('SELECT * FROM fields WHERE contract_id = ?', [contract.id]);
    
    const host = req.get('host');
    const protocol = req.protocol;
    const signUrl = signer ? `${protocol}://${host}/sign/${signer.access_token}` : null;

    res.render('detail', { contract, signer, fields, signUrl });
  } catch (err) {
    console.error(err);
    res.status(500).send('サーバーエラーが発生しました。');
  }
});

// 4. 署名画面
app.get('/sign/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const signer = await dbGet('SELECT * FROM signers WHERE access_token = ?', [token]);
    if (!signer) {
      return res.status(404).send('無効な署名URLです。または期限が切れています。');
    }
    const contract = await dbGet('SELECT * FROM contracts WHERE id = ?', [signer.contract_id]);
    const fields = await dbAll('SELECT * FROM fields WHERE contract_id = ?', [contract.id]);

    res.render('sign', { contract, signer, fields });
  } catch (err) {
    console.error(err);
    res.status(500).send('サーバーエラーが発生しました。');
  }
});

// -------------------------------------------------------------
// APIルート
// -------------------------------------------------------------

// 1. PDFアップロード (新規作成)
app.post('/api/contracts/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'PDFファイルを選択してください。' });
    }

    const id = uuidv4();
    const title = req.body.title || req.file.originalname.replace(path.extname(req.file.originalname), '');
    const filePath = `/uploads/${req.file.filename}`;
    const now = new Date().toISOString();

    await dbRun(
      'INSERT INTO contracts (id, title, status, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, title, 'DRAFT', filePath, now, now]
    );

    res.json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '契約書のアップロードに失敗しました。' });
  }
});

// 2. 契約送信
app.post('/api/contracts/:id/send', async (req, res) => {
  const contractId = req.params.id;
  const { signerName, signerEmail, fields } = req.body;

  if (!signerName || !signerEmail || !fields || !Array.isArray(fields)) {
    return res.status(400).json({ error: '入力パラメータが不足しています。' });
  }

  try {
    const contract = await dbGet('SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) {
      return res.status(404).json({ error: '契約書が見つかりません。' });
    }

    if (contract.status !== 'DRAFT') {
      return res.status(400).json({ error: 'この契約書は既に送信済みか締結済みです。' });
    }

    const signerId = uuidv4();
    const accessToken = uuidv4();
    const now = new Date().toISOString();

    await dbRun('BEGIN TRANSACTION');

    await dbRun(
      'INSERT INTO signers (id, contract_id, name, email, access_token) VALUES (?, ?, ?, ?, ?)',
      [signerId, contractId, signerName, signerEmail, accessToken]
    );

    for (const field of fields) {
      const fieldId = uuidv4();
      await dbRun(
        'INSERT INTO fields (id, contract_id, type, page_number, x_ratio, y_ratio, width_ratio, height_ratio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [fieldId, contractId, field.type, field.pageNumber, field.xRatio, field.yRatio, field.widthRatio, field.heightRatio]
      );
    }

    await dbRun(
      'UPDATE contracts SET status = ?, updated_at = ? WHERE id = ?',
      ['SENT', now, contractId]
    );

    await dbRun('COMMIT');

    const host = req.get('host');
    const protocol = req.protocol;
    const signUrl = `${protocol}://${host}/sign/${accessToken}`;

    res.json({ success: true, signUrl });
  } catch (err) {
    await dbRun('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: '契約の送信処理に失敗しました。' });
  }
});

// 3. 署名完了処理
app.post('/api/sign/:token/submit', async (req, res) => {
  const token = req.params.token;
  const { fieldValues } = req.body;

  try {
    const signer = await dbGet('SELECT * FROM signers WHERE access_token = ?', [token]);
    if (!signer) {
      return res.status(404).json({ error: '署名者セッションが見つかりません。' });
    }

    const contract = await dbGet('SELECT * FROM contracts WHERE id = ?', [signer.contract_id]);
    if (contract.status !== 'SENT') {
      return res.status(400).json({ error: 'この契約書はすでに署名済みか、無効化されています。' });
    }

    const now = new Date().toISOString();
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    await dbRun('BEGIN TRANSACTION');
    for (const [fieldId, val] of Object.entries(fieldValues)) {
      await dbRun('UPDATE fields SET value = ? WHERE id = ? AND contract_id = ?', [val, fieldId, contract.id]);
    }

    await dbRun(
      'UPDATE signers SET signed_at = ?, ip_address = ?, user_agent = ? WHERE id = ?',
      [now, ipAddress, userAgent, signer.id]
    );
    await dbRun('COMMIT');

    // PDFへの書き込み処理 (物理ファイルパスを dataDir から解決)
    const originalPdfPath = path.join(dataDir, contract.file_path);
    const pdfBytes = fs.readFileSync(originalPdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();

    const fields = await dbAll('SELECT * FROM fields WHERE contract_id = ?', [contract.id]);

    for (const field of fields) {
      if (!field.value) continue;

      const page = pages[field.page_number - 1];
      const { width, height } = page.getSize();

      const x = field.x_ratio * width;
      const y = height - (field.y_ratio * height) - (field.height_ratio * height);
      const w = field.width_ratio * width;
      const h = field.height_ratio * height;

      const base64Data = field.value.replace(/^data:image\/png;base64,/, "");
      const imageBytes = Buffer.from(base64Data, 'base64');
      const pngImage = await pdfDoc.embedPng(imageBytes);

      page.drawImage(pngImage, {
        x: x,
        y: y,
        width: w,
        height: h,
      });
    }

    // 合意証明書ページの追加
    const proofPage = pdfDoc.addPage([595.276, 841.89]);
    const { width: pWidth, height: pHeight } = proofPage.getSize();
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    proofPage.drawText('AGREEMENT CERTIFICATE', {
      x: 50,
      y: pHeight - 80,
      size: 20,
      font: helveticaBold,
    });

    proofPage.drawText('This document details the digital agreement and signing log.', {
      x: 50,
      y: pHeight - 105,
      size: 10,
      font: helveticaFont,
    });

    proofPage.drawLine({
      start: { x: 50, y: pHeight - 120 },
      end: { x: pWidth - 50, y: pHeight - 120 },
      thickness: 1,
    });

    const details = [
      { label: 'Document Name:', value: contract.title },
      { label: 'Document ID:', value: contract.id },
      { label: 'Signer Name:', value: signer.name },
      { label: 'Signer Email:', value: signer.email },
      { label: 'Date Signed:', value: new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' (JST)' },
      { label: 'IP Address:', value: ipAddress },
      { label: 'User Agent:', value: userAgent },
    ];

    let currentY = pHeight - 160;
    for (const detail of details) {
      proofPage.drawText(detail.label, {
        x: 50,
        y: currentY,
        size: 11,
        font: helveticaBold,
      });
      
      let displayValue = detail.value || '';
      if (detail.label === 'User Agent:' && displayValue.length > 60) {
        displayValue = displayValue.substring(0, 60) + '...';
      }

      proofPage.drawText(displayValue, {
        x: 180,
        y: currentY,
        size: 11,
        font: helveticaFont,
      });
      currentY -= 30;
    }

    proofPage.drawLine({
      start: { x: 50, y: 100 },
      end: { x: pWidth - 50, y: 100 },
      thickness: 1,
    });
    proofPage.drawText('Generated by Mini-Contract-System (Self-Hosted/API-Free)', {
      x: 50,
      y: 80,
      size: 8,
      font: helveticaFont,
    });

    const signedPdfBytes = await pdfDoc.save();
    const signedFileName = `signed-${contract.id}.pdf`;
    const signedFilePath = `/uploads/signed/${signedFileName}`;
    
    // 保存先の物理フルパスを定義
    const signedFullPath = path.join(dataDir, 'uploads', 'signed', signedFileName);
    const signedFullPathDir = path.dirname(signedFullPath);
    if (!fs.existsSync(signedFullPathDir)) {
      fs.mkdirSync(signedFullPathDir, { recursive: true });
    }

    fs.writeFileSync(signedFullPath, signedPdfBytes);

    await dbRun(
      'UPDATE contracts SET status = ?, signed_file_path = ?, updated_at = ? WHERE id = ?',
      ['SIGNED', signedFilePath, now, contract.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '署名の処理に失敗しました。' });
  }
});

// 契約書削除API (物理ファイルパスを dataDir から解決)
app.post('/api/contracts/:id/delete', async (req, res) => {
  try {
    const contract = await dbGet('SELECT * FROM contracts WHERE id = ?', [req.params.id]);
    if (!contract) {
      return res.status(404).json({ error: '契約書が見つかりません。' });
    }

    const files = [contract.file_path, contract.signed_file_path];
    files.forEach(f => {
      if (f) {
        const fullPath = path.join(dataDir, f);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }
    });

    await dbRun('DELETE FROM contracts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '削除処理に失敗しました。' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
