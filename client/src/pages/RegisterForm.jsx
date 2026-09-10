import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import api, { describeError } from '../api/client';
import Field from '../components/Field';
import Alert from '../components/Alert';
import Spinner from '../components/Spinner';
import QrCamera from '../components/QrCamera';
import IdUploader from '../components/IdUploader';

// Older browsers, and any context that is not secure, have no camera to offer.
// Checked once at module load so the button is simply absent rather than
// present and broken.
const CAMERA_SUPPORTED =
  typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

const EMPTY_FORM = {
  fullName: '',
  dob: '',
  gender: '',
  nationality: '',
  idType: 'AADHAAR',
  idNumber: '',
  address: '',
  phone: '',
  email: '',
  checkInDate: '',
  checkOutDate: '',
  purposeOfVisit: '',
  vehicleNumber: '',
  numberOfGuests: 1,
  consentGiven: false,
};

const AUTOFILLED_FIELDS = ['fullName', 'dob', 'gender', 'idNumber', 'address'];

const EMPTY_SIDES = {
  front: { key: null, previewUrl: null, fileName: '' },
  back: { key: null, previewUrl: null, fileName: '' },
};

export default function RegisterForm() {
  const [form, setForm] = useState(EMPTY_FORM);
  // One entry per side of the card. The front is what a guest is asked for; the
  // back holds the address, which the front desk needs and the front does not
  // carry.
  const [sides, setSides] = useState(EMPTY_SIDES);
  // Which side is mid-upload, or null. Held as a side rather than a boolean so
  // only the slot being read shows a spinner.
  const [scanningSide, setScanningSide] = useState(null);
  const [scan, setScan] = useState(null); // { tone, message }
  const [autofilled, setAutofilled] = useState([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  // Whether the filled values came from printed text rather than the QR, which
  // changes how hard the form asks the guest to check them.
  const [ocrSourced, setOcrSourced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  // Bumped on every rejected submit, so the focus effect below runs again even
  // when the same field fails twice in a row.
  const [rejectedSubmits, setRejectedSubmits] = useState(0);

  const errorRef = useRef(null);
  const formRef = useRef(null);
  // Read only by the unmount cleanup, which must see the latest previews rather
  // than the ones captured when the effect was created.
  const sidesRef = useRef(sides);
  const autofilledRef = useRef(autofilled);

  // Kept in step after each render rather than during it. Everything that reads
  // these does so from an event handler or a cleanup, both of which run after
  // the effect has caught up.
  useEffect(() => {
    sidesRef.current = sides;
    autofilledRef.current = autofilled;
  }, [sides, autofilled]);

  // Release every preview the page still holds when it unmounts. Replacements
  // are revoked as they happen, in setSide.
  useEffect(() => {
    return () => {
      for (const side of Object.values(sidesRef.current)) {
        if (side.previewUrl) URL.revokeObjectURL(side.previewUrl);
      }
    };
  }, []);

  // Move focus to whatever needs fixing, once the render carrying the new errors
  // has committed - querying the DOM inside the submit handler would run before
  // any field is marked invalid, and find nothing.
  useEffect(() => {
    if (rejectedSubmits === 0) return;

    const firstInvalid = formRef.current?.querySelector('[aria-invalid="true"]');
    if (firstInvalid) {
      firstInvalid.focus();
    } else if (errorRef.current) {
      // No field to blame - a server-level failure. Announce the message instead.
      errorRef.current.focus();
    }
  }, [rejectedSubmits]);

  function updateField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((errors) => {
      if (!errors[key]) return errors;
      const next = { ...errors };
      delete next[key];
      return next;
    });
    // A field the guest has corrected is no longer "filled in for you".
    setAutofilled((fields) => fields.filter((name) => name !== key));
  }

  // Replaces one slot, revoking whatever preview it held. Every write to `sides`
  // goes through here so a replaced photo cannot leak its object URL.
  function setSide(side, changes) {
    setSides((current) => {
      const previous = current[side];
      if (changes.previewUrl !== undefined && previous.previewUrl) {
        URL.revokeObjectURL(previous.previewUrl);
      }
      return { ...current, [side]: { ...previous, ...changes } };
    });
  }

  // One path for every way in. The camera arrives having already read the QR and
  // passes its text along; an uploaded file passes null and the server does the
  // reading. Either side of the card can auto-fill - many Aadhaar cards carry a
  // QR on both - so the response is handled the same whichever slot it came
  // from.
  async function submitScan(file, qrText, side) {
    // Read through the ref: handleScanned is created once, so its closure holds
    // the first render's value of this and would always see it as empty.
    const alreadyFilled = autofilledRef.current.length > 0;

    setSide(side, { previewUrl: URL.createObjectURL(file), fileName: file.name });
    setScanningSide(side);
    setScan(null);
    setError('');
    setFieldErrors((errors) => {
      if (!errors.idDocument) return errors;
      const next = { ...errors };
      delete next.idDocument;
      return next;
    });

    try {
      const body = new FormData();
      body.append('document', file);
      // Never the parsed fields - only the QR's own text. Parsing it, and
      // masking the Aadhaar number out of it, stays on the server where the
      // guest's browser cannot decide to skip either step.
      if (qrText) body.append('qrText', qrText);
      const { data } = await api.post('/api/document/scan', body);

      setSide(side, { key: data.documentKey || null });

      if (data.fields) {
        const filled = [];
        setForm((f) => {
          const next = { ...f };
          for (const key of AUTOFILLED_FIELDS) {
            if (data.fields[key]) {
              next[key] = data.fields[key];
              filled.push(key);
            }
          }
          return next;
        });
        // Merged, not replaced. The two sides carry different fields - name and
        // date of birth on the front, address on the back - so a second upload
        // must not un-mark what the first one filled.
        setAutofilled((current) => [...new Set([...current, ...filled])]);
        setOcrSourced(data.source === 'ocr');
        setScan({
          // Fields read off printed text are a guess where the QR is a fact, so
          // they are not announced with a tick. The guest is the only one who
          // can tell whether they are right, and the wording has to earn that
          // second look rather than assume it.
          tone: data.source === 'ocr' ? 'warning' : 'success',
          message:
            data.message ||
            'We read your Aadhaar QR code and filled in the details below. Please check them and correct anything that looks wrong.',
        });
      } else if (!alreadyFilled) {
        // Only worth saying when nothing has filled the form yet. Once the
        // details are in, a second photo that happens to carry no readable code
        // has cost the guest nothing, and telling them it "couldn't be read"
        // reads as a problem they need to go and fix.
        setScan({
          tone: 'warning',
          message: data.message || "We couldn't read this image. Please fill the form in yourself.",
        });
      }
    } catch (err) {
      // Whatever went wrong - unreachable server, timeout, a 500 - the guest's
      // way forward is the same, so say what happened and then say that.
      const { message } = describeError(err, "We couldn't read this image.");
      setScan({
        tone: 'warning',
        message: `${message} You can fill the form in yourself.`,
      });
    } finally {
      setScanningSide(null);
    }
  }

  function handleFile(side, selected) {
    if (selected) submitScan(selected, null, side);
  }

  // Stable across renders: QrCamera holds the camera open for its whole life, so
  // a prop that changed every render would restart it constantly. Capturing the
  // first render's submitScan is safe because it reads no state - only setters,
  // which React keeps stable.
  //
  // The captured frame fills the front slot only when nothing is there yet. It
  // is a close-up of the code, not a picture of a card, so it is a poor record
  // of the front - but it beats an empty slot, and a guest who later uploads a
  // proper photo replaces it.
  const handleScanned = useCallback(({ qrText, blob }) => {
    setCameraOpen(false);
    const file = new File([blob], 'aadhaar-scan.jpg', { type: 'image/jpeg' });
    submitScan(file, qrText, sidesRef.current.front.key ? 'back' : 'front');
  }, []);

  // The uploads only exist in the DOM once the camera has closed, so the close
  // is flushed before scrolling to them.
  function handleUsePhotos() {
    flushSync(() => setCameraOpen(false));
    document.getElementById('document-front')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // The form sets noValidate so errors render in the page's own style rather
  // than as browser bubbles - which means the required fields are checked here.
  // The server re-checks all of it; this only saves the guest a round trip.
  function validate() {
    const errors = {};
    if (!form.fullName.trim()) errors.fullName = 'Please enter your full name';
    if (!form.phone.trim()) errors.phone = 'Please enter a phone number';
    // The record the hotel is required to keep starts with a picture of the ID.
    // The back is not demanded: a guest holding a PAN card, or one side of
    // anything, must still be able to check in.
    if (!sides.front.key) errors.idDocument = 'Please add a photo of the front of your ID';
    if (!form.consentGiven) errors.consentGiven = 'Required';
    return errors;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError(
        errors.consentGiven && Object.keys(errors).length === 1
          ? 'Please confirm the declaration before submitting.'
          : 'Please check the highlighted fields and try again.'
      );
      setRejectedSubmits((n) => n + 1);
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/api/registrations', {
        ...form,
        idDocumentKey: sides.front.key,
        idDocumentBackKey: sides.back.key,
      });
      setSubmitted(true);
    } catch (err) {
      const described = describeError(err, 'Submission failed. Please try again.');
      setError(described.message);
      setFieldErrors(described.fieldErrors);
      setRejectedSubmits((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <main id="main" className="page page--form">
        <div className="card success-panel">
          <div className="success-panel__mark" aria-hidden="true">
            ✓
          </div>
          <h1>You're all set</h1>
          <p className="page-intro" style={{ margin: 'var(--space-3) auto 0' }}>
            Your registration has been sent to the front desk. Someone will confirm your check-in
            shortly — there is nothing else you need to do.
          </p>
        </div>
        <p className="footnote" style={{ marginTop: 'var(--space-5)' }}>
          Your ID photo is deleted once the front desk has reviewed it.
        </p>
      </main>
    );
  }

  const hint = (key) =>
    autofilled.includes(key)
      ? ocrSourced
        ? 'Read from the printed card — please check'
        : 'Filled in from your Aadhaar card'
      : undefined;

  return (
    <main id="main" className="page page--form">
      <div className="stack stack--loose">
        <header className="stack stack--tight">
          <h1>Guest registration</h1>
          <p className="page-intro">
            Please complete this before you arrive. It takes about a minute — scan the QR code on
            your Aadhaar card and most of it fills itself in.
          </p>
        </header>

        <form ref={formRef} onSubmit={handleSubmit} noValidate className="stack stack--loose">
          {/* ---------------------------------------------------- ID upload -- */}
          <section className="card stack" aria-labelledby="upload-heading">
            <h2 id="upload-heading" className="card__title">
              Your ID
            </h2>

            {cameraOpen ? (
              <QrCamera
                onDecoded={handleScanned}
                onCancel={() => setCameraOpen(false)}
                onUsePhotos={handleUsePhotos}
              />
            ) : (
              <>
                {/* First, because it is the path that works. A still photo has
                 * one attempt at a symbol that needs to fill the frame; the
                 * camera has one per frame and can say "closer" while the card
                 * is still in the guest's hand. */}
                {/* The camera fills the form; the two slots below are the
                  * record. Separated because they are different jobs: reading a
                  * dense QR needs the code to fill the frame, while a record a
                  * reviewer can read needs the whole card in it. One photo
                  * cannot do both, which is why asking for one was failing. */}
                {CAMERA_SUPPORTED && (
                  <>
                    <button
                      type="button"
                      className="btn btn--block"
                      onClick={() => setCameraOpen(true)}
                      disabled={Boolean(scanningSide)}
                    >
                      Scan my Aadhaar QR code
                    </button>
                    <p className="uploader__hint">
                      Fills your details in automatically. You still need photos of the card below.
                    </p>
                  </>
                )}

                <IdUploader
                  id="document-front"
                  label="Front of your ID"
                  hint="The side with your photo and name. Fit the whole card in the frame."
                  invalid={Boolean(fieldErrors.idDocument)}
                  busy={scanningSide === 'front'}
                  preview={sides.front.previewUrl}
                  fileName={sides.front.fileName}
                  onFile={(file) => handleFile('front', file)}
                />

                <IdUploader
                  id="document-back"
                  label="Back of your ID"
                  optional
                  hint="The side with your address. Skip this if your ID has nothing on the back."
                  busy={scanningSide === 'back'}
                  preview={sides.back.previewUrl}
                  fileName={sides.back.fileName}
                  onFile={(file) => handleFile('back', file)}
                />

                {fieldErrors.idDocument && (
                  <p className="field__error">{fieldErrors.idDocument}</p>
                )}
              </>
            )}

            {scan && <Alert tone={scan.tone}>{scan.message}</Alert>}
          </section>

          {/* ------------------------------------------------ guest details -- */}
          <section className="card stack" aria-labelledby="details-heading">
            <h2 id="details-heading" className="card__title">
              Your details
            </h2>

            <Field
              label="Full name"
              required
              value={form.fullName}
              hint={hint('fullName')}
              error={fieldErrors.fullName}
              autoComplete="name"
              onChange={(e) => updateField('fullName', e.target.value)}
            />

            <div className="grid-2">
              <Field
                label="Date of birth"
                placeholder="DD/MM/YYYY"
                value={form.dob}
                hint={hint('dob')}
                error={fieldErrors.dob}
                onChange={(e) => updateField('dob', e.target.value)}
              />
              <Field
                as="select"
                label="Gender"
                value={form.gender}
                hint={hint('gender')}
                error={fieldErrors.gender}
                onChange={(e) => updateField('gender', e.target.value)}
              >
                <option value="">Select…</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="TRANSGENDER">Transgender</option>
              </Field>
            </div>

            <div className="grid-2">
              <Field
                label="Phone"
                type="tel"
                required
                value={form.phone}
                error={fieldErrors.phone}
                autoComplete="tel"
                onChange={(e) => updateField('phone', e.target.value)}
              />
              <Field
                label="Email"
                type="email"
                optional
                value={form.email}
                error={fieldErrors.email}
                autoComplete="email"
                onChange={(e) => updateField('email', e.target.value)}
              />
            </div>

            <div className="grid-2">
              <Field
                as="select"
                label="ID type"
                value={form.idType}
                error={fieldErrors.idType}
                onChange={(e) => updateField('idType', e.target.value)}
              >
                <option value="AADHAAR">Aadhaar</option>
                <option value="PAN">PAN card</option>
                <option value="PASSPORT">Passport</option>
                <option value="DRIVING_LICENSE">Driving License</option>
                <option value="VOTER_ID">Voter ID</option>
                <option value="OTHER">Other</option>
              </Field>
              <Field
                label="ID number"
                value={form.idNumber}
                hint={
                  form.idType === 'AADHAAR'
                    ? 'Only the last 4 digits are stored'
                    : hint('idNumber')
                }
                error={fieldErrors.idNumber}
                onChange={(e) => updateField('idNumber', e.target.value)}
              />
            </div>

            <Field
              as="textarea"
              label="Address"
              value={form.address}
              hint={hint('address')}
              error={fieldErrors.address}
              rows={3}
              onChange={(e) => updateField('address', e.target.value)}
            />

            <Field
              label="Nationality"
              optional
              value={form.nationality}
              error={fieldErrors.nationality}
              onChange={(e) => updateField('nationality', e.target.value)}
            />
          </section>

          {/* -------------------------------------------------------- stay -- */}
          <section className="card stack" aria-labelledby="stay-heading">
            <h2 id="stay-heading" className="card__title">
              Your stay
            </h2>

            <div className="grid-2">
              <Field
                label="Check-in date"
                type="date"
                optional
                value={form.checkInDate}
                error={fieldErrors.checkInDate}
                onChange={(e) => updateField('checkInDate', e.target.value)}
              />
              <Field
                label="Check-out date"
                type="date"
                optional
                value={form.checkOutDate}
                error={fieldErrors.checkOutDate}
                onChange={(e) => updateField('checkOutDate', e.target.value)}
              />
            </div>

            <div className="grid-2">
              <Field
                label="Number of guests"
                type="number"
                min="1"
                max="20"
                value={form.numberOfGuests}
                error={fieldErrors.numberOfGuests}
                onChange={(e) => updateField('numberOfGuests', e.target.value)}
              />
              <Field
                label="Vehicle number"
                optional
                value={form.vehicleNumber}
                error={fieldErrors.vehicleNumber}
                onChange={(e) => updateField('vehicleNumber', e.target.value)}
              />
            </div>

            <Field
              label="Purpose of visit"
              optional
              value={form.purposeOfVisit}
              error={fieldErrors.purposeOfVisit}
              onChange={(e) => updateField('purposeOfVisit', e.target.value)}
            />
          </section>

          {/* ----------------------------------------------------- consent -- */}
          <section className="stack">
            <label className={`checkbox${fieldErrors.consentGiven ? ' checkbox--invalid' : ''}`}>
              <input
                type="checkbox"
                checked={form.consentGiven}
                aria-invalid={fieldErrors.consentGiven ? 'true' : undefined}
                onChange={(e) => updateField('consentGiven', e.target.checked)}
              />
              <span className="checkbox__text">
                I confirm the above details are accurate and consent to their use for hotel guest
                registration. My ID photo is deleted once the front desk has reviewed it.
              </span>
            </label>

            {error && (
              <div ref={errorRef} tabIndex={-1}>
                <Alert tone="error">{error}</Alert>
              </div>
            )}

            <button
              type="submit"
              className="btn btn--lg btn--block"
              disabled={submitting || Boolean(scanningSide)}
            >
              {submitting ? (
                <>
                  <Spinner label="Submitting" />
                  Submitting…
                </>
              ) : (
                'Submit registration'
              )}
            </button>

            <p className="footnote">
              Your details go only to this hotel's front desk.
            </p>
          </section>
        </form>
      </div>
    </main>
  );
}
