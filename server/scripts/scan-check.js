#!/usr/bin/env node
//
// Decodes a real Aadhaar card photo and reports exactly what came out, so the
// parser can be validated against real cards before launch.
//
//   npm run scan:check -- path/to/card.jpg
//   npm run scan:check -- ./cards/*.jpg          (any number of files)
//
// Nothing is uploaded, stored, or written anywhere. The full Aadhaar number is
// never printed - only the masked form the app would actually keep.

const path = require('path');
const fs = require('fs');
const { parseAadhaarQr } = require('../src/services/aadhaarQr.service');
const { decodeQrWithDiagnostics } = require('../src/services/qrDecoder.service');

const REQUIRED_FOR_AUTOFILL = ['fullName'];
const REPORTED_FIELDS = ['fullName', 'dob', 'gender', 'idNumber', 'address'];

function truncate(value, max = 68) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function checkOne(file) {
  const label = path.basename(file);

  if (!fs.existsSync(file)) {
    console.log(`\n${label}\n  FILE NOT FOUND`);
    return 'error';
  }

  const startedAt = Date.now();
  let qrString;
  let diagnostics = {};
  try {
    ({ text: qrString, diagnostics } = await decodeQrWithDiagnostics(file));
  } catch (err) {
    console.log(`\n${label}\n  DECODE FAILED  ${err.message}`);
    return 'error';
  }
  const decodeMs = Date.now() - startedAt;

  // Printed on failure, because "no QR found" on its own tells you nothing
  // about whether to retake the photo or reach for a different card.
  const shape = () => {
    const source = diagnostics.source;
    if (!source) return '';
    const scaled = diagnostics.downscaledTo
      ? `, decoded at ${diagnostics.downscaledTo.width}x${diagnostics.downscaledTo.height}`
      : '';
    return `  image: ${source.width}x${source.height} (${source.megapixels}MP)${scaled}`;
  };

  if (!qrString) {
    console.log(`\n${label}`);
    console.log(`  NO QR FOUND        (${decodeMs}ms)`);
    const shapeLine = shape();
    if (shapeLine) console.log(shapeLine);
    console.log('  Both decoders were tried. The guest would fill the form in by hand.');
    console.log('  Only Aadhaar cards carry a QR this can read - a PAN card, licence');
    console.log('  or passport will always land here.');
    console.log('  If it is an Aadhaar card: whole card in frame, no glare on the QR,');
    console.log('  steady hands. The symbol needs roughly a third of the frame.');
    return 'no-qr';
  }

  const format = /^\d+$/.test(qrString.trim()) ? 'secure QR (2018+)' : 'legacy XML QR';

  let fields;
  try {
    fields = parseAadhaarQr(qrString);
  } catch (err) {
    console.log(`\n${label}`);
    console.log(`  QR FOUND but UNPARSEABLE   format: ${format}`);
    console.log(`  ${err.message}`);
    return 'unparsed';
  }

  const usable = REQUIRED_FOR_AUTOFILL.every((key) => fields?.[key]);

  console.log(`\n${label}`);
  console.log(`  ${usable ? 'AUTO-FILL OK' : 'QR READ, NOT USABLE'}   format: ${format}  (${decodeMs}ms)`);

  for (const key of REPORTED_FIELDS) {
    const value = fields?.[key];
    const mark = value ? '+' : '-';
    console.log(`    ${mark} ${key.padEnd(10)} ${value ? truncate(value) : '(empty)'}`);
  }

  // The one thing that must never be true.
  if (/\b\d{12}\b/.test(JSON.stringify(fields))) {
    console.log('    !! A 12-digit number survived into the parsed fields.');
    console.log('       This is a masking bug - do not deploy. Please report it.');
    return 'leak';
  }

  return usable ? 'ok' : 'unusable';
}

async function main() {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    console.log('Usage: npm run scan:check -- <image> [more images...]');
    console.log('\nDecodes real Aadhaar card photos and prints which fields resolved.');
    console.log('Nothing is uploaded or stored. Full Aadhaar numbers are never printed.');
    process.exit(1);
  }

  const results = [];
  for (const file of files) {
    results.push(await checkOne(path.resolve(file)));
  }

  const tally = results.reduce((acc, result) => ({ ...acc, [result]: (acc[result] || 0) + 1 }), {});
  const ok = tally.ok || 0;

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${ok}/${results.length} cards auto-filled successfully.`);
  if (tally['no-qr']) console.log(`${tally['no-qr']} had no readable QR code.`);
  if (tally.unparsed) console.log(`${tally.unparsed} had a QR that did not parse as Aadhaar.`);
  if (tally.unusable) console.log(`${tally.unusable} parsed but produced no name.`);
  if (tally.error) console.log(`${tally.error} could not be read at all.`);

  if (ok < results.length) {
    console.log('\nA card that fails here still works in the app - the guest types');
    console.log('their details in instead. This measures the auto-fill hit rate.');
  }

  // A masking failure is the only result that should break a pipeline.
  process.exit(tally.leak ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
