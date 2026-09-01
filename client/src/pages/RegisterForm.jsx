import { useEffect, useRef, useState } from 'react';
import api, { describeError } from '../api/client';
import Field from '../components/Field';
import Alert from '../components/Alert';
import Spinner from '../components/Spinner';

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

export default function RegisterForm() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [documentKey, setDocumentKey] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [fileName, setFileName] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState(null); // { tone, message }
  const [autofilled, setAutofilled] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  // Bumped on every rejected submit, so the focus effect below runs again even
  // when the same field fails twice in a row.
  const [rejectedSubmits, setRejectedSubmits] = useState(0);

  const errorRef = useRef(null);
  const formRef = useRef(null);

  // Revoke the object URL when it is replaced or the page unmounts, otherwise
  // each re-photograph leaks the previous image's memory.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

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

  async function handleFile(selected) {
    if (!selected) return;

    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(selected);
    });
    setFileName(selected.name);
    setScanning(true);
    setScan(null);
    setError('');

    try {
      const body = new FormData();
      body.append('document', selected);
      const { data } = await api.post('/api/document/scan', body);

      setDocumentKey(data.documentKey || null);

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
        setAutofilled(filled);
        setScan({
          tone: 'success',
          message:
            'We read your Aadhaar QR code and filled in the details below. Please check them and correct anything that looks wrong.',
        });
      } else {
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
      setScanning(false);
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  }

  // The form sets noValidate so errors render in the page's own style rather
  // than as browser bubbles - which means the required fields are checked here.
  // The server re-checks all of it; this only saves the guest a round trip.
  function validate() {
    const errors = {};
    if (!form.fullName.trim()) errors.fullName = 'Please enter your full name';
    if (!form.phone.trim()) errors.phone = 'Please enter a phone number';
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
      await api.post('/api/registrations', { ...form, idDocumentKey: documentKey });
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

  const hint = (key) => (autofilled.includes(key) ? 'Filled in from your Aadhaar card' : undefined);

  return (
    <main id="main" className="page page--form">
      <div className="stack stack--loose">
        <header className="stack stack--tight">
          <h1>Guest registration</h1>
          <p className="page-intro">
            Please complete this before you arrive. It takes about a minute — upload a photo of your
            Aadhaar card and most of it fills itself in.
          </p>
        </header>

        <form ref={formRef} onSubmit={handleSubmit} noValidate className="stack stack--loose">
          {/* ---------------------------------------------------- ID upload -- */}
          <section className="card stack" aria-labelledby="upload-heading">
            <h2 id="upload-heading" className="card__title">
              Your ID
            </h2>

            <div
              className={`uploader${dragging ? ' uploader--dragging' : ''}${
                scanning ? ' uploader--busy' : ''
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <input
                type="file"
                id="document"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => handleFile(e.target.files?.[0])}
                disabled={scanning}
                aria-describedby="upload-hint"
              />

              {previewUrl ? (
                <div className="uploader__preview">
                  <img src={previewUrl} alt="" className="uploader__thumb" />
                  <div>
                    <p className="uploader__title">{fileName}</p>
                    <p className="uploader__hint" id="upload-hint">
                      {scanning ? 'Reading your card…' : 'Tap to choose a different photo'}
                    </p>
                  </div>
                  {scanning && <Spinner label="Reading your card" />}
                </div>
              ) : (
                <>
                  <div className="uploader__icon" aria-hidden="true">
                    ⬆
                  </div>
                  <p className="uploader__title">
                    <label htmlFor="document">Upload a photo of your Aadhaar card</label>
                  </p>
                  <p className="uploader__hint" id="upload-hint">
                    Make sure the QR code is visible and in focus. Using a different ID? Upload it
                    anyway and fill in the details below.
                  </p>
                </>
              )}
            </div>

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
              disabled={submitting || scanning}
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
