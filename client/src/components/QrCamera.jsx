import { useEffect, useRef, useState } from 'react';
import Alert from './Alert';
import Spinner from './Spinner';

// Reads the Aadhaar QR from a live camera instead of a still upload.
//
// The upload path gives a guest exactly one attempt and tells them thirty
// seconds later that it failed. Nothing about the image can be fixed after the
// shutter: a secure QR runs to ~137 modules, decoders need roughly three pixels
// per module, and a photo of a whole card does not carry them. The information
// was never captured, so no amount of server-side processing recovers it.
//
// A live stream changes the economics rather than the physics. Every frame is
// another attempt, and the guest is still holding the card while we tell them
// to move closer - so the failure gets corrected during capture, which is the
// only time it can be.
//
// Two things follow from decoding here rather than on the server:
//
//   The image never has to leave the phone to be read. What travels is the QR's
//   own text, which carries less than the photo does.
//
//   The server stops spending a wasm init and up to 2.5s of jsQR budget on
//   every guest - which on a serverless deployment is a cold start per scan.
//
// The server keeps its own decoder for the upload path, and stays the only
// place the QR is parsed and the Aadhaar number masked. See
// document.controller.js for why that division matters.

// The QR occupies this share of the frame's shorter side. It is both the region
// we decode and the box the guest sees, and that is the point: "fill the box"
// is the entire instruction, enforced by geometry instead of trusted to the
// guest to follow.
const BOX_FRACTION = 0.72;

// Failed frames before we offer advice. A dense symbol routinely takes a few
// attempts while autofocus settles, and a hint that appears instantly reads as
// an error rather than as guidance.
const FRAMES_BEFORE_HINT = 12;

// Past this with no read, offer photo uploads. A code merged by the printer
// never reads by camera, and without a way out the guest aims forever.
const GIVE_UP_MS = 15_000;

// Breathing room between attempts. The decode itself is the real throttle -
// each pass waits for the last - so this only keeps a fast phone from spending
// every cycle on frames the camera has not changed yet.
const FRAME_DELAY_MS = 60;

const READER_OPTIONS = {
  formats: ['QRCode'],
  // All three are off deliberately, and this is the opposite of the server's
  // choice. There, one image is all there will ever be, so it is worth
  // hundreds of milliseconds to wring a read out of it. Here the next frame
  // arrives in 60ms; spending that budget per frame would cut the number of
  // attempts by an order of magnitude, and attempts are what this path trades
  // in. Rotation in particular is wasted effort - the guest is aiming.
  tryHarder: false,
  tryRotate: false,
  tryInvert: false,
  maxNumberOfSymbols: 1,
};

// Ask for far more than the preview shows. The decode reads a crop of the
// native frame at its own resolution, so every pixel the sensor offers is a
// pixel spent on modules. Both are `ideal`, so a camera that cannot manage 4K
// downgrades instead of failing to open.
const CAMERA_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 3840 },
    height: { ideal: 2160 },
    // Advanced constraints are requests, not requirements: a camera that does
    // not understand focusMode ignores it rather than refusing to open. Asked
    // for because a card held still at close range is exactly the subject a
    // phone is most likely to leave focused on the background.
    advanced: [{ focusMode: 'continuous' }],
  },
};

// Loaded on demand rather than imported at the top, so the wasm module and its
// glue - about a megabyte - are fetched when a guest taps Scan, not by every
// visitor who opens the form to type their details in.
async function loadReader() {
  const [reader, wasm] = await Promise.all([
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  // zxing-wasm fetches its binary by URL in the browser. Vite hashes and
  // rewrites that URL at build time, so it has to be handed over explicitly.
  reader.prepareZXingModule({ overrides: { locateFile: () => wasm.default } });
  return reader.readBarcodes;
}

// getUserMedia's rejections are the one place a guest can be told something
// specific and true, because the browser has already worked out what went
// wrong. Everything else in this component says "move closer".
function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow it in your browser settings, or upload a photo instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. Please upload a photo instead.';
    case 'NotReadableError':
      return 'Another app is using the camera. Close it and try again, or upload a photo instead.';
    default:
      return 'The camera could not be started. Please upload a photo instead.';
  }
}

function stopStream(stream) {
  for (const track of stream?.getTracks() || []) track.stop();
}

// The frame that decoded is also the photo the front desk reviews. Capturing it
// here rather than asking for a second, separate shot means the image staff see
// is provably the one the details were read from.
function captureFrame(video) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

// What the camera can be asked to do varies by device, so the controls are
// built from what this track actually reports rather than assumed.
function readControls(track) {
  const caps = track.getCapabilities?.() || {};
  const zoom = caps.zoom
    ? {
        min: caps.zoom.min ?? 1,
        max: caps.zoom.max ?? 1,
        step: caps.zoom.step || 0.1,
      }
    : null;
  return {
    zoom: zoom && zoom.max > zoom.min ? zoom : null,
    torch: Boolean(caps.torch),
  };
}

export default function QrCamera({ onDecoded, onCancel, onUsePhotos }) {
  const videoRef = useRef(null);
  const trackRef = useRef(null);
  const [state, setState] = useState('starting');
  const [error, setError] = useState('');
  const [hint, setHint] = useState(false);
  const [stuck, setStuck] = useState(false);
  // Null until the stream is open and has said what it supports.
  const [controls, setControls] = useState({ zoom: null, torch: false });
  const [zoom, setZoom] = useState(1);
  const [torchOn, setTorchOn] = useState(false);
  // The container is matched to the stream's own shape so the preview is never
  // cropped. That is what lets the box on screen mean the same thing as the
  // region being decoded - see the crop in the loop below.
  const [aspect, setAspect] = useState(null);

  // onDecoded is read through a ref so that a caller passing an inline arrow -
  // which every render makes anew - does not tear the camera down and open it
  // again on each keystroke elsewhere in the form.
  const onDecodedRef = useRef(onDecoded);
  useEffect(() => {
    onDecodedRef.current = onDecoded;
  }, [onDecoded]);

  useEffect(() => {
    let cancelled = false;
    let stream = null;

    async function run() {
      let readBarcodes;
      try {
        readBarcodes = await loadReader();
      } catch {
        if (!cancelled) {
          setError('The scanner could not be loaded. Please upload a photo instead.');
          setState('error');
        }
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      } catch (err) {
        if (!cancelled) {
          setError(describeCameraError(err));
          setState('error');
        }
        return;
      }

      // The guest may have closed the panel while permission was pending. The
      // stream still opened, and an unreleased camera keeps its indicator lit.
      if (cancelled || !videoRef.current) {
        stopStream(stream);
        return;
      }

      const video = videoRef.current;
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Safari rejects play() if the panel closed mid-call. The loop below
        // exits on the same condition, so there is nothing else to do.
      }
      if (cancelled) return;

      const [track] = stream.getVideoTracks();
      trackRef.current = track;
      const available = readControls(track);
      setControls(available);
      setAspect(video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : null);

      // Start zoomed in a little where the camera allows it. This is the whole
      // point of having zoom here: a dense QR needs the code to fill the frame,
      // and the obvious way to manage that - moving the phone closer - runs into
      // the lens's minimum focus distance. Past a few centimetres the picture
      // goes soft, and a soft QR is unreadable however many pixels it spans.
      // Zooming reaches the same framing from a distance the camera can still
      // focus at, which is what every payment app is doing.
      if (available.zoom) {
        const start = Math.min(2, available.zoom.max);
        setZoom(start);
        try {
          await track.applyConstraints({ advanced: [{ zoom: start }] });
        } catch {
          // A camera that advertised zoom and then refused it is not worth
          // reporting: the guest can still scan, just without the help.
        }
      }

      if (cancelled) return;
      setState('scanning');

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      let failures = 0;
      const scanningSince = Date.now();
      let stuckShown = false;

      while (!cancelled) {
        const width = video.videoWidth;
        const height = video.videoHeight;

        if (width && height) {
          const size = Math.round(Math.min(width, height) * BOX_FRACTION);
          canvas.width = size;
          canvas.height = size;
          // Drawn one-to-one. Rescaling here would undo the reason the stream
          // was opened at 4K in the first place.
          context.drawImage(
            video,
            Math.round((width - size) / 2),
            Math.round((height - size) / 2),
            size,
            size,
            0,
            0,
            size,
            size
          );

          let results = [];
          try {
            results = await readBarcodes(context.getImageData(0, 0, size, size), READER_OPTIONS);
          } catch {
            // A frame the decoder chokes on is not worth reporting: the next
            // one is 60ms away.
          }
          if (cancelled) return;

          const text = results.find((result) => result.text)?.text;
          if (text) {
            const blob = await captureFrame(video);
            if (cancelled) return;
            setState('captured');
            onDecodedRef.current({ qrText: text, blob });
            return;
          }

          failures += 1;
          if (failures === FRAMES_BEFORE_HINT) setHint(true);
          if (!stuckShown && Date.now() - scanningSince > GIVE_UP_MS) {
            stuckShown = true;
            setStuck(true);
          }
        }

        await new Promise((resolve) => setTimeout(resolve, FRAME_DELAY_MS));
      }
    }

    run();

    return () => {
      cancelled = true;
      trackRef.current = null;
      stopStream(stream);
    };
  }, []);

  async function applyZoom(value) {
    setZoom(value);
    try {
      await trackRef.current?.applyConstraints({ advanced: [{ zoom: value }] });
    } catch {
      // Ignored for the same reason as the initial zoom: scanning continues.
    }
  }

  async function toggleTorch() {
    const next = !torchOn;
    setTorchOn(next);
    try {
      await trackRef.current?.applyConstraints({ advanced: [{ torch: next }] });
    } catch {
      setTorchOn(!next);
    }
  }

  if (state === 'error') {
    return (
      <div className="stack">
        <Alert tone="warning">{error}</Alert>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Close camera
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      {/* Shaped to the stream, so the whole frame is visible and nothing is
        * cropped away. The box below is then the same 72% of the shorter side
        * that gets decoded - without this the two disagree, and a guest who
        * neatly fills the box on screen is not filling the region being read. */}
      <div className="qr-camera" style={aspect ? { aspectRatio: String(aspect) } : undefined}>
        <video ref={videoRef} className="qr-camera__video" playsInline muted />
        <div
          className="qr-camera__box"
          aria-hidden="true"
          style={
            aspect && aspect > 1
              ? { height: `${BOX_FRACTION * 100}%` }
              : { width: `${BOX_FRACTION * 100}%` }
          }
        />
        {state === 'starting' && (
          <div className="qr-camera__status">
            <Spinner label="Starting the camera" />
          </div>
        )}
      </div>

      {(controls.zoom || controls.torch) && (
        <div className="qr-camera__controls">
          {controls.zoom && (
            <label className="qr-camera__zoom">
              <span>Zoom</span>
              <input
                type="range"
                min={controls.zoom.min}
                max={controls.zoom.max}
                step={controls.zoom.step}
                value={zoom}
                onChange={(event) => applyZoom(Number(event.target.value))}
              />
              <span className="qr-camera__zoom-value">{zoom.toFixed(1)}×</span>
            </label>
          )}
          {controls.torch && (
            <button
              type="button"
              className={`btn btn--sm${torchOn ? '' : ' btn--secondary'}`}
              onClick={toggleTorch}
              aria-pressed={torchOn}
            >
              {torchOn ? 'Light on' : 'Light off'}
            </button>
          )}
        </div>
      )}

      <p className="qr-camera__hint" role="status">
        {state === 'starting'
          ? 'Starting the camera…'
          : hint
            ? controls.zoom
              ? 'Nothing yet — fill the square with the code, using zoom rather than moving closer. Too close and the camera cannot focus.'
              : 'Nothing yet — fill the square with the code, and hold steady while it focuses.'
            : 'Hold the QR code on your Aadhaar card inside the square.'}
      </p>

      {stuck && (
        <>
          <Alert tone="warning">
            Still can't read the code. Some cards, especially small ones printed at home or at a
            shop, have a QR code no camera can read. Upload photos of the front and back instead and
            we'll read the printed details.
          </Alert>
          {onUsePhotos && (
            <button type="button" className="btn btn--block" onClick={onUsePhotos}>
              Use photos instead
            </button>
          )}
        </>
      )}

      <button type="button" className="btn btn--ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
