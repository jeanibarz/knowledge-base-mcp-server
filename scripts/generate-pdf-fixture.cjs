#!/usr/bin/env node
// Regenerate src/__fixtures__/sample.pdf — the small valid PDF used by the
// loader tests (issue #46). Run on demand after upgrading pdfkit; the
// committed fixture should normally not change.
//
// Note: pdfkit's PDF document IDs are random per-run and certain seeds have
// historically produced xref tables that pdfjs rejects ("bad XRef entry").
// The runtime impact is nil (we mock pdf-parse in jest, and real-world PDFs
// from common producers parse fine), but the verification step here may need
// a few retries.

const PDFDocument = require('pdfkit');
const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, '..', 'src', '__fixtures__', 'sample.pdf');
const MAX_ATTEMPTS = 25;

async function generateOnce() {
  const doc = new PDFDocument({ info: { Title: 'kb46-test' } });
  const chunks = [];
  await new Promise((resolve) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', resolve);
    doc.fontSize(14).text('Hello loader test from issue 46', 100, 100);
    doc.text('Second line for non-trivial extraction.', 100, 130);
    doc.end();
  });
  return Buffer.concat(chunks);
}

(async () => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const buf = await generateOnce();
    let result;
    const parser = new PDFParse({ data: buf });
    try {
      result = await parser.getText();
    } catch (err) {
      // pdfjs occasionally chokes on pdfkit output; retry with a fresh
      // document ID.
      continue;
    } finally {
      await parser.destroy();
    }
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, buf);
    const preview = result.text.replace(/\s+/g, ' ').trim();
    console.log(
      `wrote ${OUT_PATH} (${buf.length} bytes, attempt ${attempt}); text preview: "${preview}"`,
    );
    return;
  }
  console.error(
    `failed: pdf-parse rejected ${MAX_ATTEMPTS} pdfkit-generated PDFs in a row`,
  );
  process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
