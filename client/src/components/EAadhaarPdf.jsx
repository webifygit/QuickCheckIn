import { useState } from 'react';
import Alert from './Alert';
import Spinner from './Spinner';

// Reads the secure QR out of an e-Aadhaar PDF on the guest's own phone. The PDF
// holds the full signed record, so it is opened here and never uploaded - only
// the QR's text goes to the server, the same as a camera read.
//
// Tried smallest first. A rendered PDF has perfectly sharp edges, so 2x decodes
// even at ~1.7px per module; larger scales cover a PDF that embeds the QR small.
// Pages past the canvas ceiling are skipped rather than risked on mobile Safari.
const SCALES = [2, 3, 4];
const MAX_CANVAS_PIXELS = 16_000_000;
const READER_OPTIONS = { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 };

async function loadLibraries() {
  const [pdfjs, worker, reader, wasm] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  reader.prepareZXingModule({ overrides: { locateFile: () => wasm.default } });
  return { pdfjs, readBarcodes: reader.readBarcodes };
}

async function readQrFromPdf(file, password) {
  const { pdfjs, readBarcodes } = await loadLibraries();
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data, password: password || undefined });

  try {
    const pdf = await loadingTask.promise;
    for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 2); pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      for (const scale of SCALES) {
        const viewport = page.getViewport({ scale });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        if (width * height > MAX_CANVAS_PIXELS) break;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        // 'print' stops pdf.js pacing the render on requestAnimationFrame, which
        // never fires while the page is hidden - a guest switching apps mid-read
        // would otherwise be left on "Reading…" forever.
        await page.render({ canvas, canvasContext: context, viewport, intent: 'print' }).promise;

        let results = [];
        try {
          results = await readBarcodes(context.getImageData(0, 0, width, height), READER_OPTIONS);
        } finally {
          // A rendered A4 page runs to several megabytes; release it before the next try.
          canvas.width = 0;
          canvas.height = 0;
        }

        const text = results.find((result) => result.text)?.text;
        if (text) return text;
      }
    }
    return null;
  } finally {
    // Destroyed on failure too: a wrong password otherwise leaks a worker per attempt.
    loadingTask.destroy();
  }
}

function describePdfError(err) {
  if (err?.name === 'PasswordException') {
    return err.code === 2
      ? "That password didn't open the PDF. It's the first 4 letters of your name as printed on Aadhaar, in capitals, then your birth year."
      : 'This PDF is password-protected. Please enter its password.';
  }
  return "We couldn't open that file. Please check it's your e-Aadhaar PDF.";
}

export default function EAadhaarPdf({ onDecoded, disabled = false }) {
  const [file, setFile] = useState(null);
  const [password, setPassword] = useState('');
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState('');

  async function read() {
    if (!file) return;
    setReading(true);
    setProblem('');
    try {
      const text = await readQrFromPdf(file, password.trim());
      if (text) {
        setFile(null);
        setPassword('');
        onDecoded(text);
      } else {
        setProblem("We opened the PDF but couldn't find a QR code in it. Is this your e-Aadhaar?");
      }
    } catch (err) {
      setProblem(describePdfError(err));
    } finally {
      setReading(false);
    }
  }

  return (
    <details className="pdf-reader">
      <summary>Have your e-Aadhaar PDF? Use it instead</summary>
      <div className="stack">
        <p className="uploader__hint pdf-reader__lead">
          The QR code inside the PDF reads perfectly, even if your card is a small cut-out. The PDF
          stays on your phone and is never uploaded.
        </p>

        <label className="field">
          <span className="field__label">e-Aadhaar PDF</span>
          <input
            type="file"
            accept="application/pdf"
            onChange={(event) => {
              setFile(event.target.files?.[0] || null);
              setProblem('');
            }}
            disabled={reading || disabled}
          />
        </label>

        <label className="field">
          <span className="field__label">PDF password</span>
          <input
            className="input"
            value={password}
            onChange={(event) => setPassword(event.target.value.toUpperCase())}
            placeholder="e.g. ANIL1990"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            disabled={reading || disabled}
          />
          <span className="field__hint">
            First 4 letters of your name as printed on Aadhaar, in capitals, then your birth year.
          </span>
        </label>

        {problem && <Alert tone="warning">{problem}</Alert>}

        <button
          type="button"
          className="btn btn--secondary btn--block"
          onClick={read}
          disabled={!file || reading || disabled}
        >
          {reading ? (
            <>
              <Spinner label="Reading your PDF" />
              Reading…
            </>
          ) : (
            'Read my e-Aadhaar'
          )}
        </button>
      </div>
    </details>
  );
}
