import { useState } from 'react';
import Spinner from './Spinner';

// One upload slot. There are two of these on the form - the front of the card
// and the back - because a single photo cannot serve both jobs the front desk
// needs it for.
//
// The front carries the name, photo and date of birth; the back carries the
// address. Photographed together in one frame, each side gets half the pixels,
// and a printed address at half resolution is exactly the thing a reviewer
// cannot read. Two frames, two full resolutions.
export default function IdUploader({
  id,
  label,
  hint,
  optional = false,
  invalid = false,
  busy = false,
  preview,
  fileName,
  onFile,
}) {
  const [dragging, setDragging] = useState(false);
  const hintId = `${id}-hint`;

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    onFile(event.dataTransfer.files?.[0]);
  }

  return (
    <div
      className={`uploader${dragging ? ' uploader--dragging' : ''}${busy ? ' uploader--busy' : ''}${
        invalid ? ' uploader--invalid' : ''
      }`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        type="file"
        id={id}
        accept="image/jpeg,image/png,image/webp"
        onChange={(event) => onFile(event.target.files?.[0])}
        disabled={busy}
        aria-describedby={hintId}
        aria-invalid={invalid ? 'true' : undefined}
      />

      {preview ? (
        <div className="uploader__preview">
          <img src={preview} alt="" className="uploader__thumb" />
          <div>
            <p className="uploader__title">
              <label htmlFor={id}>{label}</label>
            </p>
            <p className="uploader__hint" id={hintId}>
              {busy ? 'Reading your card…' : fileName || 'Tap to choose a different photo'}
            </p>
          </div>
          {busy && <Spinner label="Reading your card" />}
        </div>
      ) : (
        <>
          <div className="uploader__icon" aria-hidden="true">
            ⬆
          </div>
          <p className="uploader__title">
            <label htmlFor={id}>
              {label}
              {optional && <span className="uploader__optional"> (optional)</span>}
            </label>
          </p>
          <p className="uploader__hint" id={hintId}>
            {hint}
          </p>
        </>
      )}
    </div>
  );
}
