const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const nodemailer = require('nodemailer');
const { buildContractPdf } = require('./build_pdf');

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

// -------------------------------------------------------------
// Nodemailer SMTP設定と送信関数
// -------------------------------------------------------------
const smtpHost = process.env.SMTP_HOST;
const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 587;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;

let transporter = null;

if (smtpHost && smtpUser && smtpPass) {
  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });
  console.log('SMTP transporter configured successfully.');
} else {
  console.log('SMTP variables are not fully configured. Automated emails will be disabled.');
}

async function sendMail({ to, subject, html, attachments = [] }) {
  if (!transporter) {
    console.warn(`[Mail Skipped] SMTP not configured. Mail to ${to} was not sent.`);
    return false;
  }
  try {
    const info = await transporter.sendMail({
      from: `"Mini Sign" <${smtpUser}>`,
      to,
      subject,
      html,
      attachments,
    });
    console.log(`Email sent: ${info.messageId} to ${to}`);
    return true;
  } catch (err) {
    console.error(`Failed to send email to ${to}:`, err);
    return false;
  }
}

// 簡易CSVパースヘルパー
function parseCSV(text) {
  const lines = [];
  let row = [""];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i+1];
    if (c === '"') {
      if (inQuotes && next === '"') {
        row[row.length - 1] += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push("");
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') {
        i++;
      }
      lines.push(row);
      row = [""];
    } else {
      row[row.length - 1] += c;
    }
  }
  if (row.length > 1 || row[0] !== "") {
    lines.push(row);
  }
  return lines;
}

// Expressの設定
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(dataDir, 'uploads')));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Multerの設定 (CSVアップロード対応)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dest = path.join(dataDir, 'uploads');
    if (file.fieldname === 'templatePdf') {
      dest = path.join(dataDir, 'uploads', 'templates');
    }
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'pdf' || file.fieldname === 'templatePdf') {
      if (file.mimetype === 'application/pdf') cb(null, true);
      else cb(new Error('PDFファイルのみアップロード可能です。'), false);
    } else if (file.fieldname === 'csvFile') {
      cb(null, true); // CSVファイルのバリデーションは拡張子等で行う
    } else {
      cb(null, true);
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
      SELECT c.*, 
             group_concat(s.name || ' (' || s.role || ')', ', ') as signers_info,
             group_concat(s.email, ', ') as signers_emails
      FROM contracts c
      LEFT JOIN signers s ON c.id = s.contract_id
      GROUP BY c.id
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
    const signers = await dbAll('SELECT * FROM signers WHERE contract_id = ?', [contract.id]);
    const fields = await dbAll('SELECT * FROM fields WHERE contract_id = ?', [contract.id]);
    
    const sender = signers.find(s => s.role === 'SENDER');
    const recipient = signers.find(s => s.role === 'RECIPIENT');

    const host = req.get('host');
    const protocol = req.protocol;

    const senderSignUrl = sender ? `${protocol}://${host}/sign/${sender.access_token}` : null;
    const recipientSignUrl = recipient ? `${protocol}://${host}/sign/${recipient.access_token}` : null;

    res.render('detail', { 
      contract, 
      sender, 
      recipient, 
      fields, 
      senderSignUrl, 
      recipientSignUrl 
    });
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
    const signers = await dbAll('SELECT * FROM signers WHERE contract_id = ?', [contract.id]);
    const fields = await dbAll('SELECT * FROM fields WHERE contract_id = ?', [contract.id]);

    res.render('sign', { contract, signer, signers, fields });
  } catch (err) {
    console.error(err);
    res.status(500).send('サーバーエラーが発生しました。');
  }
});

// 5. 【新規】テンプレート管理一覧
app.get('/templates', async (req, res) => {
  try {
    const templates = await dbAll('SELECT * FROM templates ORDER BY created_at DESC');
    res.render('templates', { templates });
  } catch (err) {
    console.error(err);
    res.status(500).send('サーバーエラーが発生しました。');
  }
});

// 6. 【新規】テンプレート編集・フィールド配置画面
app.get('/templates/edit/:id', async (req, res) => {
  try {
    const template = await dbGet('SELECT * FROM templates WHERE id = ?', [req.params.id]);
    if (!template) {
      return res.status(404).send('テンプレートが見つかりません。');
    }
    const fields = await dbAll('SELECT * FROM template_fields WHERE template_id = ?', [template.id]);
    res.render('template_edit', { template, fields });
  } catch (err) {
    console.error(err);
    res.status(500).send('サーバーエラーが発生しました。');
  }
});

// 7. 【新規】CSVインポート・流し込み設定画面
app.get('/templates/:id/import', async (req, res) => {
  try {
    const template = await dbGet('SELECT * FROM templates WHERE id = ?', [req.params.id]);
    if (!template) {
      return res.status(404).send('テンプレートが見つかりません。');
    }
    const prefillFields = await dbAll(
      "SELECT placeholder_name FROM template_fields WHERE template_id = ? AND type = 'prefill' GROUP BY placeholder_name",
      [template.id]
    );
    res.render('csv_import', { template, prefillFields });
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

// 2. 契約送信 (甲・乙2名の署名枠を保存)
app.post('/api/contracts/:id/send', async (req, res) => {
  const contractId = req.params.id;
  const { senderName, senderEmail, recipientName, recipientEmail, fields } = req.body;

  if (!senderName || !senderEmail || !recipientName || !recipientEmail || !fields || !Array.isArray(fields)) {
    return res.status(400).json({ error: '入力パラメータが不足しています。' });
  }

  try {
    const contract = await dbGet('SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) {
      return res.status(404).json({ error: '契約書が見つかりません。' });
    }

    if (contract.status !== 'DRAFT') {
      return res.status(400).json({ error: 'この契約書はすでに送信済みか締結済みです。' });
    }

    const senderId = uuidv4();
    const senderToken = uuidv4();
    const recipientId = uuidv4();
    const recipientToken = uuidv4();
    const now = new Date().toISOString();

    await dbRun('BEGIN TRANSACTION');

    await dbRun(
      'INSERT INTO signers (id, contract_id, name, email, role, access_token, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [senderId, contractId, senderName, senderEmail, 'SENDER', senderToken, now]
    );
    await dbRun(
      'INSERT INTO signers (id, contract_id, name, email, role, access_token) VALUES (?, ?, ?, ?, ?, ?)',
      [recipientId, contractId, recipientName, recipientEmail, 'RECIPIENT', recipientToken]
    );

    for (const field of fields) {
      const fieldId = uuidv4();
      const targetSignerId = (field.role === 'SENDER') ? senderId : recipientId;

      await dbRun(
        'INSERT INTO fields (id, contract_id, signer_id, type, page_number, x_ratio, y_ratio, width_ratio, height_ratio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [fieldId, contractId, targetSignerId, field.type, field.pageNumber, field.xRatio, field.yRatio, field.widthRatio, field.heightRatio]
      );
    }

    await dbRun(
      'UPDATE contracts SET status = ?, updated_at = ? WHERE id = ?',
      ['SENT', now, contractId]
    );

    await dbRun('COMMIT');

    const host = req.get('host');
    const protocol = req.protocol;
    const senderSignUrl = `${protocol}://${host}/sign/${senderToken}`;
    const recipientSignUrl = `${protocol}://${host}/sign/${recipientToken}`;

    // 自動メール送信
    const senderMailSubject = `【署名依頼】契約書「${contract.title}」の署名手続きを開始してください`;
    const senderMailHtml = `
      <p><strong>${senderName} 様</strong></p>
      <p>契約書「${contract.title}」の署名手続き用のURLを発行しました。</p>
      <p>まずは以下のリンクより、ご自身の署名を行ってください。</p>
      <p style="margin: 20px 0;">
        <a href="${senderSignUrl}" style="display: inline-block; padding: 12px 24px; background-color: #6366f1; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold; font-family: sans-serif;">
          自分の署名画面を開く
        </a>
      </p>
      <p>また、相手方（${recipientName} 様）の署名用リンクは以下になります：</p>
      <p><a href="${recipientSignUrl}">${recipientSignUrl}</a></p>
      <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 20px 0;">
      <p style="font-size: 0.85rem; color: #6b7280;">※本メールはシステムより自動送信されています。</p>
    `;
    sendMail({ to: senderEmail, subject: senderMailSubject, html: senderMailHtml });

    const recipientMailSubject = `【署名依頼】契約書「${contract.title}」への署名をお願いします`;
    const recipientMailHtml = `
      <p><strong>${recipientName} 様</strong></p>
      <p>${senderName} 様より、契約書「${contract.title}」の署名依頼が届いています。</p>
      <p>以下のリンクより契約内容をご確認の上、署名手続きを行ってください。</p>
      <p style="margin: 20px 0;">
        <a href="${recipientSignUrl}" style="display: inline-block; padding: 12px 24px; background-color: #6366f1; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold; font-family: sans-serif;">
          契約書を確認して署名する
        </a>
      </p>
      <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 20px 0;">
      <p style="font-size: 0.85rem; color: #6b7280;">※本メールはシステムより自動送信されています。</p>
    `;
    sendMail({ to: recipientEmail, subject: recipientMailSubject, html: recipientMailHtml });

    res.json({ success: true });
  } catch (err) {
    await dbRun('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: '契約の送信処理に失敗しました。' });
  }
});

// 3. 署名完了処理 (二者全員の署名が揃ったらPDF合成 + 証明書結合)
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
      return res.status(400).json({ error: 'この契約書はすでに締結完了しているか、無効化されています。' });
    }

    const now = new Date().toISOString();
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    await dbRun('BEGIN TRANSACTION');

    for (const [fieldId, val] of Object.entries(fieldValues)) {
      await dbRun('UPDATE fields SET value = ? WHERE id = ? AND signer_id = ?', [val, fieldId, signer.id]);
    }

    await dbRun(
      'UPDATE signers SET signed_at = ?, ip_address = ?, user_agent = ? WHERE id = ?',
      [now, ipAddress, userAgent, signer.id]
    );

    await dbRun('COMMIT');

    const pendingSigners = await dbAll('SELECT * FROM signers WHERE contract_id = ? AND signed_at IS NULL', [contract.id]);
    
    if (pendingSigners.length === 0) {
      const originalPdfPath = path.join(dataDir, contract.file_path);
      const pdfBytes = fs.readFileSync(originalPdfPath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      pdfDoc.registerFontkit(fontkit);
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

      const proofPage = pdfDoc.addPage([595.276, 841.89]);
      const { width: pWidth, height: pHeight } = proofPage.getSize();
      
      const possiblePaths = [
        '/usr/share/fonts/ipafont/ipag.ttf',
        '/usr/share/fonts/font-ipa/ipag.ttf',
        '/usr/share/fonts/font-ipa/ipag.otf',
        '/usr/share/fonts/ipa/ipag.ttf'
      ];
      let fontPath = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          fontPath = p;
          break;
        }
      }

      let customFont;
      if (fontPath) {
        const fontBytes = fs.readFileSync(fontPath);
        customFont = await pdfDoc.embedFont(fontBytes);
      } else {
        customFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
      }

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
        font: helveticaBold,
      });

      proofPage.drawLine({
        start: { x: 50, y: pHeight - 120 },
        end: { x: pWidth - 50, y: pHeight - 120 },
        thickness: 1,
      });

      proofPage.drawText('Document Name:', { x: 50, y: pHeight - 150, size: 10, font: helveticaBold });
      proofPage.drawText(contract.title, { x: 180, y: pHeight - 150, size: 10, font: customFont });
      
      proofPage.drawText('Document ID:', { x: 50, y: pHeight - 170, size: 10, font: helveticaBold });
      proofPage.drawText(contract.id, { x: 180, y: pHeight - 170, size: 10, font: customFont });

      const allSigners = await dbAll('SELECT * FROM signers WHERE contract_id = ? ORDER BY role DESC', [contract.id]);
      
      let currentY = pHeight - 210;

      for (const sg of allSigners) {
        const roleLabel = (sg.role === 'SENDER') ? 'Sender (甲):' : 'Recipient (乙):';

        proofPage.drawText(roleLabel, { x: 50, y: currentY, size: 11, font: helveticaBold });
        proofPage.drawText(sg.name, { x: 180, y: currentY, size: 11, font: customFont });

        proofPage.drawText('Email:', { x: 50, y: currentY - 20, size: 9, font: helveticaBold });
        proofPage.drawText(sg.email, { x: 180, y: currentY - 20, size: 9, font: customFont });

        proofPage.drawText('Signed At:', { x: 50, y: currentY - 35, size: 9, font: helveticaBold });
        proofPage.drawText(new Date(sg.signed_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' (JST)', { x: 180, y: currentY - 35, size: 9, font: customFont });

        proofPage.drawText('IP Address:', { x: 50, y: currentY - 50, size: 9, font: helveticaBold });
        proofPage.drawText(sg.ip_address || '', { x: 180, y: currentY - 50, size: 9, font: customFont });

        let uaStr = sg.user_agent || '';
        if (uaStr.length > 60) uaStr = uaStr.substring(0, 60) + '...';
        proofPage.drawText('Environment:', { x: 50, y: currentY - 65, size: 9, font: helveticaBold });
        proofPage.drawText(uaStr, { x: 180, y: currentY - 65, size: 9, font: customFont });

        proofPage.drawLine({
          start: { x: 50, y: currentY - 80 },
          end: { x: pWidth - 50, y: currentY - 80 },
          thickness: 0.5,
          color: { r: 0.8, g: 0.8, b: 0.8 }
        });

        currentY -= 100;
      }

      proofPage.drawText('Generated by Mini-Contract-System (Self-Hosted/API-Free)', {
        x: 50,
        y: 40,
        size: 8,
        font: customFont,
      });

      const signedPdfBytes = await pdfDoc.save();
      const signedFileName = `signed-${contract.id}.pdf`;
      const signedFilePath = `/uploads/signed/${signedFileName}`;
      
      const signedFullPath = path.join(dataDir, 'uploads', 'signed', signedFileName);
      fs.writeFileSync(signedFullPath, signedPdfBytes);

      await dbRun(
        'UPDATE contracts SET status = ?, signed_file_path = ?, updated_at = ? WHERE id = ?',
        ['SIGNED', signedFilePath, now, contract.id]
      );

      const pdfAttachment = {
        filename: `${contract.title}_signed.pdf`,
        path: signedFullPath,
      };

      const mailSubject = `【契約締結完了】「${contract.title}」が締結されました`;
      const mailHtml = `
        <p>関係者 各位</p>
        <p>電子契約システム「Mini Sign」にて、契約書「${contract.title}」の双方の署名が完了し、契約が締結されました。</p>
        <p>合意証明書が含まれる締結済みのPDFを添付いたしましたので、ご確認ください。</p>
        <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 20px 0;">
        <p style="font-size: 0.85rem; color: #6b7280;">※本メールはシステムより自動送信されています。</p>
      `;
      
      const sender = allSigners.find(s => s.role === 'SENDER');
      const recipient = allSigners.find(s => s.role === 'RECIPIENT');

      if (sender) sendMail({ to: sender.email, subject: mailSubject, html: mailHtml, attachments: [pdfAttachment] });
      if (recipient) sendMail({ to: recipient.email, subject: mailSubject, html: mailHtml, attachments: [pdfAttachment] });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '署名の処理に失敗しました。' });
  }
});

// -------------------------------------------------------------
// 【新規】テンプレート関連 APIルート
// -------------------------------------------------------------

// 1. テンプレートPDFアップロード (ひな形登録)
app.post('/api/templates/upload', upload.single('templatePdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'PDFファイルを選択してください。' });
    }

    const id = uuidv4();
    const title = req.body.title || req.file.originalname.replace(path.extname(req.file.originalname), '');
    const filePath = `/uploads/templates/${req.file.filename}`;
    const now = new Date().toISOString();

    await dbRun(
      'INSERT INTO templates (id, title, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [id, title, filePath, now, now]
    );

    res.json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'テンプレートのアップロードに失敗しました。' });
  }
});

// 2. テンプレート定義（差し込み座標＆署名枠）の保存
app.post('/api/templates/:id/save', async (req, res) => {
  const templateId = req.params.id;
  const { fields } = req.body; // Array of fields: { type, signerRole, placeholderName, pageNumber, xRatio, yRatio, widthRatio, heightRatio }

  if (!fields || !Array.isArray(fields)) {
    return res.status(400).json({ error: '配置フィールド情報が不正です。' });
  }

  try {
    const template = await dbGet('SELECT * FROM templates WHERE id = ?', [templateId]);
    if (!template) {
      return res.status(404).json({ error: 'テンプレートが見つかりません。' });
    }

    const now = new Date().toISOString();

    await dbRun('BEGIN TRANSACTION');
    
    // 既存のフィールド定義を削除
    await dbRun('DELETE FROM template_fields WHERE template_id = ?', [templateId]);

    // 新しい定義をインサート
    for (const field of fields) {
      const fieldId = uuidv4();
      await dbRun(
        `INSERT INTO template_fields (id, template_id, type, signer_role, placeholder_name, page_number, x_ratio, y_ratio, width_ratio, height_ratio)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fieldId,
          templateId,
          field.type,
          field.signerRole || 'SYSTEM',
          field.placeholderName || null,
          field.pageNumber,
          field.xRatio,
          field.yRatio,
          field.widthRatio,
          field.heightRatio
        ]
      );
    }

    await dbRun('UPDATE templates SET updated_at = ? WHERE id = ?', [now, templateId]);
    await dbRun('COMMIT');

    res.json({ success: true });
  } catch (err) {
    await dbRun('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'テンプレート定義の保存に失敗しました。' });
  }
});

// 3. テンプレート削除 API
app.post('/api/templates/:id/delete', async (req, res) => {
  try {
    const template = await dbGet('SELECT * FROM templates WHERE id = ?', [req.params.id]);
    if (!template) {
      return res.status(404).json({ error: 'テンプレートが見つかりません。' });
    }

    const fullPath = path.join(dataDir, template.file_path);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }

    await dbRun('DELETE FROM templates WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'テンプレートの削除に失敗しました。' });
  }
});

// 4. 【核心】CSV流し込み ＆ 一括送信API
app.post('/api/templates/:id/import-submit', upload.single('csvFile'), async (req, res) => {
  const templateId = req.params.id;
  const mapping = JSON.parse(req.body.mapping); 
  // mapping structure: { 
  //   prefillMap: { templatePlaceholderName: csvColumnHeaderName }, 
  //   senderNameCol, senderEmailCol, recipientNameCol, recipientEmailCol 
  // }

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'CSVファイルをアップロードしてください。' });
    }

    const template = await dbGet('SELECT * FROM templates WHERE id = ?', [templateId]);
    if (!template) {
      return res.status(404).json({ error: 'テンプレートが見つかりません。' });
    }

    // テンプレート構成情報を取得
    const templateFields = await dbAll('SELECT * FROM template_fields WHERE template_id = ?', [templateId]);

    // CSVテキストの読み込みとパース
    const csvFullPath = path.join(dataDir, 'uploads', req.file.filename);
    const csvContent = fs.readFileSync(csvFullPath, 'utf-8');
    fs.unlinkSync(csvFullPath); // 解析が終わったらCSVファイルは削除

    const rows = parseCSV(csvContent);
    if (rows.length < 2) {
      return res.status(400).json({ error: 'CSVに有効なデータが含まれていません。' });
    }

    const headers = rows[0].map(h => h.trim());
    const dataRows = rows.slice(1);

    // 日本語フォント (font-ipa) のロード
    const possiblePaths = [
      '/usr/share/fonts/ipafont/ipag.ttf',
      '/usr/share/fonts/font-ipa/ipag.ttf',
      '/usr/share/fonts/font-ipa/ipag.otf',
      '/usr/share/fonts/ipa/ipag.ttf'
    ];
    let fontPath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        fontPath = p;
        break;
      }
    }

    let customFont;
    if (fontPath) {
      const fontBytes = fs.readFileSync(fontPath);
      customFont = fontBytes; // 各ループ内で埋め込むため、ここではバイトデータを保持
    }

    const originalPdfPath = path.join(dataDir, template.file_path);
    const pdfBytes = fs.readFileSync(originalPdfPath);

    const createdContracts = [];

    // 行ごとにPDFを合成 & 契約書を発行
    for (const row of dataRows) {
      if (row.length === 0 || row.join('').trim() === '') continue;

      // 行データをオブジェクト化 { [HeaderName]: Value }
      const rowData = {};
      headers.forEach((header, idx) => {
        rowData[header] = row[idx] ? row[idx].trim() : '';
      });

      // 差出人と受取人の情報を取得
      let senderName = '';
      let senderEmail = '';

      if (mapping.senderMode === 'fixed') {
        senderName = mapping.senderFixedName;
        senderEmail = mapping.senderFixedEmail;
      } else {
        senderName = rowData[mapping.senderNameCol];
        senderEmail = rowData[mapping.senderEmailCol];
      }

      const recipientName = rowData[mapping.recipientNameCol];
      const recipientEmail = rowData[mapping.recipientEmailCol];
      const recipientAddress = mapping.recipientAddressCol ? (rowData[mapping.recipientAddressCol] || '') : '';

      if (!senderName || !senderEmail || !recipientName || !recipientEmail) {
        console.warn('Skipping CSV row due to missing sender/recipient info:', rowData);
        continue;
      }

      // --- ① 受取人の名前・住所を埋め込んだ契約書PDFを生成する ---
      console.log(`[Import] Building PDF for ${recipientName} / address: ${recipientAddress || '(なし)'}`);
      const prefilledPdfBytes = await buildContractPdf(recipientName, recipientAddress);

      const uniqueSuffix = uuidv4();
      const newPdfFileName = `contract-prefilled-${uniqueSuffix}.pdf`;
      const newPdfFilePath = `/uploads/${newPdfFileName}`;
      const newPdfFullPath = path.join(dataDir, 'uploads', newPdfFileName);

      fs.writeFileSync(newPdfFullPath, prefilledPdfBytes);

      // --- ② データベースに契約と署名者を保存 ---
      const contractId = uuidv4();
      const senderId = uuidv4();
      const senderToken = uuidv4();
      const recipientId = uuidv4();
      const recipientToken = uuidv4();
      const now = new Date().toISOString();

      await dbRun('BEGIN TRANSACTION');

      // 契約親
      await dbRun(
        'INSERT INTO contracts (id, title, status, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [contractId, `${template.title}_${recipientName}`, 'SENT', newPdfFilePath, now, now]
      );

      // 署名者2名 (甲は最初から署名済み)
      await dbRun(
        'INSERT INTO signers (id, contract_id, name, email, role, access_token, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [senderId, contractId, senderName, senderEmail, 'SENDER', senderToken, now]
      );
      await dbRun(
        'INSERT INTO signers (id, contract_id, name, email, role, access_token) VALUES (?, ?, ?, ?, ?, ?)',
        [recipientId, contractId, recipientName, recipientEmail, 'RECIPIENT', recipientToken]
      );

      // 署名枠・テキスト枠などの配置フィールド（prefill以外）の保存
      const interactiveFields = templateFields.filter(f => f.type !== 'prefill');
      for (const field of interactiveFields) {
        const fieldId = uuidv4();
        const targetSignerId = (field.signer_role === 'SENDER') ? senderId : recipientId;

        await dbRun(
          'INSERT INTO fields (id, contract_id, signer_id, type, page_number, x_ratio, y_ratio, width_ratio, height_ratio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [fieldId, contractId, targetSignerId, field.type, field.page_number, field.x_ratio, field.y_ratio, field.width_ratio, field.height_ratio]
        );
      }

      await dbRun('COMMIT');

      // --- ③ 署名依頼メールの送信 (非同期) ---
      if (mapping.sendEmails) {
        const host = req.get('host');
        const protocol = req.protocol;
        const senderSignUrl = `${protocol}://${host}/sign/${senderToken}`;
        const recipientSignUrl = `${protocol}://${host}/sign/${recipientToken}`;

        const senderMailSubject = `【署名依頼】契約書「${template.title}_${recipientName}」の署名手続きを開始してください`;
        const senderMailHtml = `
          <p><strong>${senderName} 様</strong></p>
          <p>スプレッドシート流し込みにより、契約書「${template.title}_${recipientName}」の自動発行が完了しました。</p>
          <p>まずは以下のリンクより、ご自身の署名を行ってください。</p>
          <p style="margin: 20px 0;">
            <a href="${senderSignUrl}" style="display: inline-block; padding: 12px 24px; background-color: #6366f1; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold; font-family: sans-serif;">
              自分の署名画面を開く
            </a>
          </p>
          <p>また、相手方（${recipientName} 様）の署名用リンクは以下になります：</p>
          <p><a href="${recipientSignUrl}">${recipientSignUrl}</a></p>
        `;
        sendMail({ to: senderEmail, subject: senderMailSubject, html: senderMailHtml });

        const recipientMailSubject = `【署名依頼】契約書「${template.title}_${recipientName}」への署名をお願いします`;
        const recipientMailHtml = `
          <p><strong>${recipientName} 様</strong></p>
          <p>${senderName} 様より、契約書「${template.title}_${recipientName}」の署名依頼が届いています。</p>
          <p>以下のリンクより内容をご確認の上、署名手続きを行ってください。</p>
          <p style="margin: 20px 0;">
            <a href="${recipientSignUrl}" style="display: inline-block; padding: 12px 24px; background-color: #6366f1; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold; font-family: sans-serif;">
              契約書を確認して署名する
            </a>
          </p>
        `;
        sendMail({ to: recipientEmail, subject: recipientMailSubject, html: recipientMailHtml });
      } else {
        console.log(`[Import] Skipped sending emails for contract ${contractId} (sendEmails is false)`);
      }

      createdContracts.push({ contractId, recipientName });

      // メモリ解放を促すための短い非同期スリープ
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    res.json({ success: true, count: createdContracts.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '一括送信処理中にエラーが発生しました。' });
  }
});

// 契約書削除API
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

// 全契約書一括削除API
app.post('/api/contracts/delete-all', async (req, res) => {
  try {
    const contracts = await dbAll('SELECT * FROM contracts');
    for (const contract of contracts) {
      const files = [contract.file_path, contract.signed_file_path];
      files.forEach(f => {
        if (f) {
          const fullPath = path.join(dataDir, f);
          if (fs.existsSync(fullPath)) {
            try { fs.unlinkSync(fullPath); } catch (e) {}
          }
        }
      });
    }

    await dbRun('BEGIN TRANSACTION');
    await dbRun('DELETE FROM fields');
    await dbRun('DELETE FROM signers');
    await dbRun('DELETE FROM contracts');
    await dbRun('COMMIT');

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '全契約書の削除中にエラーが発生しました。' });
  }
});

// 契約書個別の手動メール送信API
app.post('/api/contracts/:id/send-email', async (req, res) => {
  try {
    const contract = await dbGet('SELECT * FROM contracts WHERE id = ?', [req.params.id]);
    if (!contract) {
      return res.status(404).json({ error: '契約書が見つかりません。' });
    }

    const signers = await dbAll('SELECT * FROM signers WHERE contract_id = ?', [contract.id]);
    const recipient = signers.find(s => s.role === 'RECIPIENT');

    if (!recipient || !recipient.email) {
      return res.status(400).json({ error: '相手方のメールアドレスが登録されていません。' });
    }

    const host = req.get('host');
    const protocol = req.protocol;
    const recipientSignUrl = `${protocol}://${host}/sign/${recipient.access_token}`;

    const subject = `【重要】契約書「${contract.title}」のご確認・同意のお願い`;
    const htmlContent = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <p style="font-size: 1rem; color: #1e293b;"><strong>${recipient.name} 様</strong></p>
        
        <p style="font-size: 0.95rem; color: #334155; line-height: 1.6;">
          お世話になっております。株式会社Coedo Music Labo です。<br>
          作成いたしました契約書をご案内いたします。
        </p>

        <div style="background-color: #f8fafc; border-left: 4px solid #6366f1; padding: 15px; margin: 20px 0; border-radius: 4px;">
          <p style="font-size: 0.95rem; color: #1e293b; margin: 0; font-weight: bold;">
            📌 ご案内
          </p>
          <p style="font-size: 0.9rem; color: #475569; margin: 8px 0 0 0; line-height: 1.5;">
            下記ボタンより契約書リンクを開き、内容をよくお読みいただいた上で、同意チェックを行って完了させてください。
          </p>
        </div>

        <p style="text-align: center; margin: 30px 0;">
          <a href="${recipientSignUrl}" style="display: inline-block; padding: 14px 28px; background-color: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 1rem; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.2);">
            契約書の内容を確認して同意する
          </a>
        </p>

        <p style="font-size: 0.8rem; color: #64748b; line-height: 1.4;">
          ※ボタンがクリックできない場合は、以下のURLを直接ブラウザにコピー＆ペーストして開いてください：<br>
          <a href="${recipientSignUrl}" style="color: #4f46e5;">${recipientSignUrl}</a>
        </p>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0 20px 0;">

        <div style="font-size: 0.85rem; color: #475569; line-height: 1.6;">
          <p style="margin: 0; font-weight: bold; color: #1e293b;">━━━━━━━━━━━━━━━━━━━━━━━━━━━━</p>
          <p style="margin: 4px 0; font-weight: bold; color: #1e293b;">株式会社Coedo Music Labo</p>
          <p style="margin: 4px 0;">〒356-0004 埼玉県ふじみ野市上福岡3-16-10 朝日パリオ上福岡703</p>
          <p style="margin: 4px 0;">代表取締役：宮下 晋</p>
          <p style="margin: 4px 0;">Email：<a href="mailto:susumu.miyashita@coedo-music.jp" style="color: #4f46e5;">susumu.miyashita@coedo-music.jp</a></p>
          <p style="margin: 0; font-weight: bold; color: #1e293b;">━━━━━━━━━━━━━━━━━━━━━━━━━━━━</p>
        </div>
      </div>
    `;

    sendMail({ to: recipient.email, subject: subject, html: htmlContent });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'メールの送信中にエラーが発生しました。' });
  }
});

app.get('/api/debug-fonts', (req, res) => {
  const fontDir = '/usr/share/fonts';
  const results = [];
  
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const list = fs.readdirSync(dir);
    list.forEach(file => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat && stat.isDirectory()) {
        walk(fullPath);
      } else {
        results.push(fullPath);
      }
    });
  }
  
  try {
    walk(fontDir);
    res.json({ fonts: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
