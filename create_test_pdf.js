const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

async function createPdf() {
  try {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.276, 841.89]); // A4
    const { width, height } = page.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    page.drawText('NON-DISCLOSURE & SERVICE AGREEMENT', {
      x: 50,
      y: height - 100,
      size: 20,
      font: font,
    });

    page.drawText('This is a test agreement generated automatically to verify the signing workflow.', {
      x: 50,
      y: height - 140,
      size: 11,
      font: font,
    });

    page.drawText('By signing this document, the parties agree to maintain strict confidentiality', {
      x: 50,
      y: height - 170,
      size: 11,
      font: font,
    });

    page.drawText('regarding all shared information and technical designs.', {
      x: 50,
      y: height - 190,
      size: 11,
      font: font,
    });

    page.drawText('1. Term: This agreement shall be effective for 3 years from the date of signing.', {
      x: 50,
      y: height - 240,
      size: 11,
      font: font,
    });

    page.drawText('2. Governing Law: This agreement shall be governed by local regulations.', {
      x: 50,
      y: height - 270,
      size: 11,
      font: font,
    });

    // 署名エリアの目印
    page.drawText('Signer Name:', {
      x: 50,
      y: 180,
      size: 12,
      font: font,
    });

    page.drawText('Date of Agreement:', {
      x: 50,
      y: 130,
      size: 12,
      font: font,
    });

    page.drawText('Signature:', {
      x: 50,
      y: 70,
      size: 12,
      font: font,
    });

    const pdfBytes = await pdfDoc.save();
    const outputPath = path.join(__dirname, 'test_contract.pdf');
    fs.writeFileSync(outputPath, pdfBytes);
    console.log(`Created test PDF at: ${outputPath}`);
  } catch (err) {
    console.error('Error generating PDF:', err);
  }
}

createPdf();
