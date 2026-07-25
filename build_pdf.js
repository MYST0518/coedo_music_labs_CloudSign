const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');

// 1行の最大幅に合わせて文字列を折り返す簡易関数
function wrapText(text, fontSize, font, maxWidth) {
  const words = text.split('');
  let lines = [];
  let currentLine = '';

  for (let i = 0; i < words.length; i++) {
    const char = words[i];
    const testLine = currentLine + char;
    const width = font.widthOfTextAtSize(testLine, fontSize);
    if (width > maxWidth && currentLine !== '') {
      lines.push(currentLine);
      currentLine = char;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine !== '') {
    lines.push(currentLine);
  }
  return lines;
}

/**
 * 契約書PDFを生成してバイト列で返す
 * @param {string} recipientName  - 乙の氏名（空文字の場合は空欄のまま）
 * @param {string} recipientAddress - 乙の住所（空文字の場合は空欄のまま）
 * @returns {Promise<Uint8Array>} PDFバイト列
 */
async function buildContractPdf(recipientName = '', recipientAddress = '') {

  // --- 本文テキスト ---
  // 乙の名前を本文の○○部分に埋め込む
  const recipientLabel = recipientName ? recipientName : '　　　　　　　　';

  const embedText = `「暴音族オムニバスアルバム -Ｂ.Ｏ.Ｕ.Ｏ.Ｎ-」音楽原盤制作契約書

本契約は、株式会社Coedo Music Labo（以下「甲」という）と、${recipientLabel}（以下「乙」という）との間において、「暴音族オムニバスアルバム -Ｂ.Ｏ.Ｕ.Ｏ.Ｎ- 」（以下「本件原盤」という）の制作およびその利用に関し、以下の通り締結する。

第1条（定義）
本契約において使用する用語の定義は、以下の通りとする。
(1) 「本件原盤」：実演家（乙または乙が指定する第三者）の実演を最初に固定したマスターテープ、DAW（デジタル・オーディオ・ワークステーション）データ、その他媒体の如何を問わず一切の固定媒体をいう。
(2) 「実演」：本件原盤に収録される歌唱、演奏、朗詠、その他芸能的な行為をいう。
(3) 「商業用レコード」：本件原盤を複製したCD等のパッケージ製品、およびストリーミング配信（サブスクリプション・サービスを含む）、ダウンロード配信、その他将来開発される一切の形式によるデジタル音源をいう。

第2条（制作業務および費用の負担）
① 甲は乙に対し、本件原盤の制作業務を委託し、乙はこれを受託する。
② 本件原盤の制作に要する以下の費用は、すべて甲が負担し、乙に金銭的負担は一切生じないものとする。
(1) マスタリング費用、ISRC（国際標準レコーディングコード）およびPOSサブコード of 登録費用、実店舗流通にまつわる費用。
(2) その他、制作に付随して発生する一切の直接経費
③ 乙は、本件原盤の制作に関し、自己負担金が発生しないことを甲に確認するものとする。ただし、乙の扱うAI生成のクレジット費用やDAWサービスのサブスクリプション等は乙の負担とする。

第3条（権利の帰属および人格権の取扱い）
① 本件原盤に係る所有権、および著作権法上のレコード製作者の権利（複製権、送信可能化権、譲渡権、貸与権、二次使用料を受ける権利、貸与報酬請求権等を含む著作隣接権のすべて）は、本契約の有効期間中、甲に独占的かつ完全に帰属する。ただし、第7条に定める特約を妨げない。
② 乙は、甲が本件原盤を自由に編集、改変、翻案、または第三者へ利用許諾（サブライセンス）できることを承諾する。
③ 本件原盤に係る著作隣接権（レコード製作者の権利）、所有権、および将来発生しうる一切の権利は、本件原盤の完成と同時に甲に帰属するものとする。
④ 前各項の規定にかかわらず、乙は本件原盤に関する著作者人格権および実演家人格権（氏名表示権、同一性保持権等）を放棄せず、これらを乙に留保する。
⑤ 甲は、本件原盤を公表または利用するにあたり、乙が指定する名義で乙の氏名を表示しなければならない。万一、クレジット表記に誤りまたは漏れがあった場合、甲は、速やかにメタデータの修正や次回のプレス等、是現に必要な合理的措置を講ずるものとする。

第4条（収益分配およびリクープ）
①（リクープ優先）
第7条に定める乙自身による自由配信の場合を除き、本件原盤から生じる一切の収益（パッケージ販売、音楽配信、二次利用料等）は、甲が支出した第2条第2項の原盤制作費（以下「初期費用」という）を全額回収（以下「リクープ」という）するまで、甲がその100%を取得するものとする。
②（リクープ完了後の分配）
甲が初期費用の全額をリクープした後に発生した収益については、甲は乙に対し、商業用レコードの販売・配信における税抜純売上（または甲が受領した金額）の50％をアーティスト印税（ロイヤリティ）として支払うものとする。
③（製品の買い取り）乙は、本件原盤を用いた本件CDの制作完了後、別途甲乙間で合意する数量および卸価格に基づき、本件CDを買い受けるものとする。

第5条（会計報告および支払い）
①（報告の頻度）
甲は乙に対し、本件原盤に係る収益額および現在のリクープ進捗状況を明記した計上報告書を開示するものとする。ただし、初期費用のリクープ完了までは【毎年1回 / または乙からの書面による請求があった場合のみ】とし、リクープ完了後は3ヶ月（四半期）ごとに行うものとする。
②（支払い）
リクープ完了後に乙への支払いが発生する場合、甲は確定した金額を当該計上期間の翌々月末日までに乙の指定口座に振り込む。振込手数料は甲の負担とする。
③（支払最低額）
該当期間における乙への支払金額が3,000円（消費税別）に満たない場合は、甲は支払いを次期以降に繰り越すことができるものとする。ただし、契約終了時または原盤の利用停止時には、残額を全額支払う。

第6条（著作権利用に関する特約：委嘱免除および自己利用）
① 本プロジェクトにおける楽曲利用を円滑化し、甲の使用料負担を免除するため、乙は以下の義務を負う。
(1) 委嘱免除（直接取引）の適用：乙が本件楽曲の著作権をJASRAC等の著作権管理団体に信託している場合、本件楽曲が甲の依頼に基づき特定のプロジェクトのために制作された「委嘱楽曲」であることを鑑み、信託契約約款に基づく「委嘱免除」の手続きを事前に行うとする。これにより、本プロジェクトに関連する特定の利用について、甲は管理団体に使用料を支払うことなく、乙との直接取引として本件楽曲を利用できる。
(2) 自己利用特例の活用：乙が音楽出版社と著作権契約を締結していない楽曲については、JASRACの定める「自己利用」の規定を適用する。乙は、以下の利用規模上限を超えない範囲での利用が使用料請求の対象外となるよう、事前に管理団体へ届け出なければならない。
・演奏会等：入場料 × 会場定員数 ≦ 400万円
・複製物（CD等）：媒体の種類ごとに 2,000枚（部）まで
・インターネット配信：配信期間 3ヶ月まで、またはリクエスト数 1,000回まで
② プロモーション利用：作品のプロモーション目的で対価を得ずに行う使用については、乙は「自己利用」の届出により、甲に使用料負担が生じないよう協力するものとする。
③ 前各項の手続きに関わらず、乙の手続き不備や上限超過等の事由により、著作権管理団体等から甲に対して著作権使用料の請求がなされた場合、当該費用は乙の負担（または乙への分配金から控除）とする。ただし、甲の責めに帰すべき事由による場合はこの限りではない。

第7条（アーティストによる自由配信の特約）
① 甲は乙に対し、本件原盤を乙自身が選定するプラットフォームまたはディストリビューターを通じて、乙の名義で自由に音楽配信（ダウンロードおよびストリーミング）を行うための、非独占的、無償かつ永続的な利用許諾（ライセンス）を与えるものとする。
② 前項に基づき、乙自身が行う配信活動から生じる収益は、100％乙に帰属し、甲はこれを受領する権利を放棄する。
③ 乙が本条に基づき取得する収益は、第4条に定める甲のリクープ計算には一切算入しないものとし、甲は当該収益から制作費の回収を主張できないものとする。

第8条（保証および紛争解決）
① 乙は甲に対し、本件原盤に収録される楽曲および実演が、第三者の著作権、著作隣接権、その他の権利を侵害していないことを保証する。
② 本契約に関して紛争が生じた場合、甲乙は誠実に協議して解決を図る。協議によって解決しない場合は、東京地方裁判所を第一審の専属的合意管轄裁判所とする。

第9条（契約期間および終了後の取扱い）
① 本契約の有効期間は、本契約締結日から３年間とする。ただし、期間満了の3ヶ月前までに、甲乙いずれからも相手方に対する書面による解約の申し出がない限り、本契約は同条件でさらに1年間自動的に更新されるものとし、以後も同様とする。
② 前項の規定に関わらず、初期費用のリクープが完了していない場合であっても、本契約が期間満了により終了（更新拒絶を含む）したときは、本件原盤に係る著作隣接権および所有権は、終了日をもって甲から乙へ無償で移転（返還）されるものとする。ただし、契約終了前に甲が第三者と締結した利用許諾契約（サブライセンス）については、その期間満了まで存続するものとする。

第10条（一般条項）
①（秘密保持）
双方は、本契約に関連して知り得た相手方の営業上または技術上の秘密情報を、相手方の書面による事前の承諾なく第三者に漏洩してはならない。
②（反社会的勢力の排除）
双方は、自己および自己の役員が反社会的勢力に該当しないこと、および反社会的勢力と一切の関係を有していないことを表明し、保証する。
③（契約の解除）
一方が本契約の条項に違反し、相当期間を定めた催告後も是正されない場合、他方は本契約の全部または一部を将来に向かって解除することができる。
④（存続条項）
本契約が終了した後も、第3条（権利の帰属および人格権の取扱い）、第6条第3項（著作権料の負担）、第8条（保証および紛争解決）、および本条第1項（秘密保持）の規定は有効に継続する。

--------------------------------------------------------------------------------
本契約の成立を証するため、本書2通を作成し、甲乙署名のうえ、各1通を保有する。

令和8年　　月　　日

甲：　埼玉県ふじみ野市上福岡3-16-10朝日パリオ上福岡703
　　　株式会社Coedo Music Labo
　　　代表取締役　宮下 晋

乙：`;

  const lines = embedText.split('\n');
  const startIdx = lines.findIndex(line => line.includes('「暴音族オムニバスアルバム'));
  const contractTextLines = lines.slice(startIdx);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // 本番環境（Alpine）の日本語フォントパスの自動探索
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
    console.warn('Japanese font not found. Falling back to Helvetica.');
  }

  let page = pdfDoc.addPage([595.276, 841.89]); // A4
  const { width, height } = page.getSize();

  const marginX = 55;
  const marginY = 60;
  const printableWidth = width - (marginX * 2);

  let currentY = height - marginY;
  const lineSpacing = 16;
  const paragraphSpacing = 10;

  for (let rawLine of contractTextLines) {
    let line = rawLine.trim();

    if (line === '') {
      currentY -= paragraphSpacing;
      continue;
    }

    const isTitle = line.includes('「暴音族オムニバスアルバム') && line.includes('契約書');
    const isHeader = line.startsWith('第') && (line.includes('条') || line.includes('項'));
    const isSeparator = line.startsWith('----');

    const fontSize = isTitle ? 16 : (isHeader ? 11 : 9.5);

    let wLineSource = line;
    if (!fontPath) {
      wLineSource = wLineSource.replace(/[^\x00-\x7F]/g, '*');
    }

    if (isSeparator) {
      if (currentY - 10 < marginY) {
        page = pdfDoc.addPage([595.276, 841.89]);
        currentY = height - marginY;
      }
      page.drawLine({
        start: { x: marginX, y: currentY - 5 },
        end: { x: width - marginX, y: currentY - 5 },
        thickness: 0.5,
        color: rgb(0.5, 0.5, 0.5)
      });
      currentY -= 15;
      continue;
    }

    const wrappedLines = wrapText(wLineSource, fontSize, customFont, printableWidth);

    for (let wLine of wrappedLines) {
      if (currentY - fontSize < marginY) {
        page = pdfDoc.addPage([595.276, 841.89]);
        currentY = height - marginY;
      }

      let drawX = marginX;
      if (isTitle) {
        const textWidth = customFont.widthOfTextAtSize(wLine, fontSize);
        drawX = marginX + (printableWidth - textWidth) / 2;
      }

      page.drawText(wLine, {
        x: drawX,
        y: currentY - fontSize,
        size: fontSize,
        font: customFont,
        color: rgb(0, 0, 0)
      });

      currentY -= (fontSize + lineSpacing - 9.5);
    }
    currentY -= 6;
  }

  // =====================================================
  // 乙の署名欄（住所・氏名を自動印字 + 手書き用スペース）
  // =====================================================
  if (currentY - 150 < marginY) {
    page = pdfDoc.addPage([595.276, 841.89]);
    currentY = height - marginY;
  }

  currentY -= 10;
  const sigFontSize = 10;
  const indent = marginX + 25; // 「乙：」の後のインデント

  // ---- 住所 ----
  if (fontPath) {
    page.drawText('住所：', { x: indent, y: currentY - sigFontSize, size: sigFontSize, font: customFont, color: rgb(0, 0, 0) });
  } else {
    page.drawText('Address:', { x: indent, y: currentY - sigFontSize, size: sigFontSize, font: customFont });
  }

  const addrLabelWidth = customFont.widthOfTextAtSize(fontPath ? '住所：' : 'Address:', sigFontSize);
  const addrStartX = indent + addrLabelWidth + 4;
  const addrEndX = width - marginX;

  if (recipientAddress) {
    // 住所を印字（折り返し対応）
    const addrLines = wrapText(
      fontPath ? recipientAddress : recipientAddress.replace(/[^\x00-\x7F]/g, '*'),
      sigFontSize,
      customFont,
      addrEndX - addrStartX
    );
    for (let i = 0; i < addrLines.length; i++) {
      page.drawText(addrLines[i], {
        x: addrStartX,
        y: currentY - sigFontSize - i * (sigFontSize + 4),
        size: sigFontSize,
        font: customFont,
        color: rgb(0, 0, 0)
      });
    }
  }
  // 住所の下線
  page.drawLine({
    start: { x: addrStartX, y: currentY - sigFontSize - 2 },
    end: { x: addrEndX, y: currentY - sigFontSize - 2 },
    thickness: 0.5,
    color: rgb(0, 0, 0)
  });

  currentY -= 30;

  // ---- 氏名 ----
  if (fontPath) {
    page.drawText('氏名：', { x: indent, y: currentY - sigFontSize, size: sigFontSize, font: customFont, color: rgb(0, 0, 0) });
  } else {
    page.drawText('Name:', { x: indent, y: currentY - sigFontSize, size: sigFontSize, font: customFont });
  }

  const nameLabelWidth = customFont.widthOfTextAtSize(fontPath ? '氏名：' : 'Name:', sigFontSize);
  const nameStartX = indent + nameLabelWidth + 4;
  const nameEndX = width - marginX;

  if (recipientName) {
    page.drawText(
      fontPath ? recipientName : recipientName.replace(/[^\x00-\x7F]/g, '*'),
      {
        x: nameStartX,
        y: currentY - sigFontSize,
        size: sigFontSize,
        font: customFont,
        color: rgb(0, 0, 0)
      }
    );
  }
  // 氏名の下線
  page.drawLine({
    start: { x: nameStartX, y: currentY - sigFontSize - 2 },
    end: { x: nameEndX, y: currentY - sigFontSize - 2 },
    thickness: 0.5,
    color: rgb(0, 0, 0)
  });

  currentY -= 40;

  // ---- 署名（手書きスペース）----
  if (fontPath) {
    page.drawText('署名：', { x: indent, y: currentY - sigFontSize, size: sigFontSize, font: customFont, color: rgb(0, 0, 0) });
  } else {
    page.drawText('Signature:', { x: indent, y: currentY - sigFontSize, size: sigFontSize, font: customFont });
  }
  const sigLabelWidth = customFont.widthOfTextAtSize(fontPath ? '署名：' : 'Signature:', sigFontSize);
  // 手書き署名のためのBOX（縦50px）
  const sigBoxStartX = indent + sigLabelWidth + 4;
  const sigBoxEndX = sigBoxStartX + 200;
  const sigBoxTopY = currentY - sigFontSize + 2;
  const sigBoxBottomY = sigBoxTopY - 50;
  page.drawRectangle({
    x: sigBoxStartX,
    y: sigBoxBottomY,
    width: sigBoxEndX - sigBoxStartX,
    height: 50,
    borderColor: rgb(0.6, 0.6, 0.6),
    borderWidth: 0.5,
  });

  currentY -= 65;

  // ---- 日付（手書きスペース）----
  if (fontPath) {
    page.drawText('令和　　年　　月　　日', { x: indent, y: currentY - sigFontSize, size: sigFontSize, font: customFont, color: rgb(0, 0, 0) });
  } else {
    page.drawText('Date: ___/___/___', { x: indent, y: currentY - sigFontSize, size: sigFontSize, font: customFont });
  }

  return await pdfDoc.save();
}

// ==========================================
// スタンドアロン実行（テンプレートPDF生成）
// ==========================================
async function main() {
  const pdfBytes = await buildContractPdf('', '');

  const dataDir = process.env.DATA_DIR || __dirname;
  const destDir = path.join(dataDir, 'uploads', 'templates');
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  const outputPath = path.join(destDir, 'buon_template.pdf');
  fs.writeFileSync(outputPath, pdfBytes);
  console.log('Template PDF generated at:', outputPath);
}

module.exports = { buildContractPdf };

// 直接実行された場合はmain()を呼ぶ
if (require.main === module) {
  main().catch(err => {
    console.error('Error generating PDF:', err);
    process.exit(0);
  });
}
