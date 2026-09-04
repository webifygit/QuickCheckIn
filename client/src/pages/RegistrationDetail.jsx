import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api, { clearSession, describeError } from '../api/client';
import AppShell from '../components/AppShell';
import Field from '../components/Field';
import Alert from '../components/Alert';
import Spinner from '../components/Spinner';
import StatusBadge, { STATUS_LABELS } from '../components/StatusBadge';
import IdDocumentPreview from '../components/IdDocumentPreview';

const DECISIONS = ['PENDING', 'APPROVED', 'CHECKED_IN', 'REJECTED'];

// Only these are sent back on a save. Listing them beats stripping server-managed
// keys out of the record: a field added to the API later cannot leak into a PATCH
// by accident.
const EDITABLE_FIELDS = [
  'fullName', 'dob', 'gender', 'nationality', 'idType', 'idNumber', 'address',
  'phone', 'email', 'checkInDate', 'checkOutDate', 'purposeOfVisit',
  'vehicleNumber', 'numberOfGuests',
];

// Moving to any of these deletes the guest's ID photo, so the reviewer is told
// before it happens rather than discovering it afterwards.
const PURGES_DOCUMENT = new Set(['APPROVED', 'CHECKED_IN', 'REJECTED']);

// <input type="date"> wants YYYY-MM-DD, and the API returns an ISO timestamp.
function toDateInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export default function RegistrationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [registration, setRegistration] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const { data } = await api.get(`/api/registrations/${id}`, { signal: controller.signal });
        setRegistration(data);
        setForm({ ...data, checkInDate: toDateInput(data.checkInDate), checkOutDate: toDateInput(data.checkOutDate) });
      } catch (err) {
        const described = describeError(err, 'Could not load this registration.');
        // A superseded load. Its data is stale by definition, and dropping it
        // into the form would wipe out anything typed while it was in flight.
        if (described.cancelled) return;
        if (described.status === 401) {
          clearSession();
          navigate('/login', { replace: true });
          return;
        }
        setError(described.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    load();
    return () => controller.abort();
  }, [id, navigate]);

  function updateField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
    setFieldErrors((errors) => {
      if (!errors[key]) return errors;
      const next = { ...errors };
      delete next[key];
      return next;
    });
  }

  async function save(overrides = {}) {
    setSaving(true);
    setError('');
    setFieldErrors({});
    try {
      const editable = Object.fromEntries(
        EDITABLE_FIELDS.filter((key) => key in form).map((key) => [key, form[key]])
      );
      const { data } = await api.patch(`/api/registrations/${id}`, { ...editable, ...overrides });
      setRegistration(data);
      setForm({ ...data, checkInDate: toDateInput(data.checkInDate), checkOutDate: toDateInput(data.checkOutDate) });
      setSaved(true);
    } catch (err) {
      const described = describeError(err, 'Could not save these changes.');
      if (described.status === 401) {
        clearSession();
        navigate('/login', { replace: true });
        return;
      }
      setError(
        described.status === 404
          ? 'This registration no longer exists. It may have been deleted from another device.'
          : described.message
      );
      setFieldErrors(described.fieldErrors);
    } finally {
      setSaving(false);
    }
  }

  function decide(status) {
    if (
      PURGES_DOCUMENT.has(status) &&
      registration?.hasIdDocument &&
      !window.confirm(
        `Marking this ${STATUS_LABELS[status].toLowerCase()} will permanently delete the guest's ID photo. Continue?`
      )
    ) {
      return;
    }
    save({ status });
  }

  if (loading) {
    return (
      <AppShell>
        <div className="card stack" aria-busy="true">
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="skeleton" style={{ width: `${90 - row * 10}%` }} />
          ))}
          <span className="visually-hidden">Loading registration…</span>
        </div>
      </AppShell>
    );
  }

  if (!registration || !form) {
    return (
      <AppShell>
        <div className="stack">
          <Link to="/dashboard" className="back-link">
            ← Back to dashboard
          </Link>
          <Alert tone="error">{error || 'This registration could not be found.'}</Alert>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="stack stack--loose">
        <div className="stack stack--tight">
          <Link to="/dashboard" className="back-link">
            ← Back to dashboard
          </Link>
          <div className="row row--between">
            <h1>{registration.fullName}</h1>
            <StatusBadge status={registration.status} />
          </div>
          <p className="page-intro">
            Submitted {new Date(registration.createdAt).toLocaleString()}
          </p>
        </div>

        <div className="detail-layout">
          {/* ------------------------------------------------ editable form -- */}
          <section className="card stack" aria-labelledby="details-heading">
            <div className="card__header">
              <h2 id="details-heading" className="card__title">
                Guest details
              </h2>
              {saved && <span className="field__hint">Saved</span>}
            </div>

            <Field
              label="Full name"
              value={form.fullName || ''}
              error={fieldErrors.fullName}
              onChange={(e) => updateField('fullName', e.target.value)}
            />

            <div className="grid-2">
              <Field
                label="Date of birth"
                value={form.dob || ''}
                error={fieldErrors.dob}
                onChange={(e) => updateField('dob', e.target.value)}
              />
              <Field
                as="select"
                label="Gender"
                value={form.gender || ''}
                error={fieldErrors.gender}
                onChange={(e) => updateField('gender', e.target.value)}
              >
                <option value="">Not given</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="TRANSGENDER">Transgender</option>
              </Field>
            </div>

            <div className="grid-2">
              <Field
                label="Phone"
                value={form.phone || ''}
                error={fieldErrors.phone}
                onChange={(e) => updateField('phone', e.target.value)}
              />
              <Field
                label="Email"
                value={form.email || ''}
                error={fieldErrors.email}
                onChange={(e) => updateField('email', e.target.value)}
              />
            </div>

            <div className="grid-2">
              <Field
                as="select"
                label="ID type"
                value={form.idType || 'AADHAAR'}
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
                value={form.idNumber || ''}
                hint={form.idType === 'AADHAAR' ? 'Stored masked to the last 4 digits' : undefined}
                error={fieldErrors.idNumber}
                onChange={(e) => updateField('idNumber', e.target.value)}
              />
            </div>

            <Field
              as="textarea"
              label="Address"
              rows={3}
              value={form.address || ''}
              error={fieldErrors.address}
              onChange={(e) => updateField('address', e.target.value)}
            />

            <div className="grid-2">
              <Field
                label="Check-in date"
                type="date"
                value={form.checkInDate || ''}
                error={fieldErrors.checkInDate}
                onChange={(e) => updateField('checkInDate', e.target.value)}
              />
              <Field
                label="Check-out date"
                type="date"
                value={form.checkOutDate || ''}
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
                value={form.numberOfGuests ?? 1}
                error={fieldErrors.numberOfGuests}
                onChange={(e) => updateField('numberOfGuests', e.target.value)}
              />
              <Field
                label="Vehicle number"
                value={form.vehicleNumber || ''}
                error={fieldErrors.vehicleNumber}
                onChange={(e) => updateField('vehicleNumber', e.target.value)}
              />
            </div>

            <Field
              label="Purpose of visit"
              value={form.purposeOfVisit || ''}
              error={fieldErrors.purposeOfVisit}
              onChange={(e) => updateField('purposeOfVisit', e.target.value)}
            />

            {error && <Alert tone="error">{error}</Alert>}

            <div className="row">
              <button type="button" className="btn" onClick={() => save()} disabled={saving}>
                {saving ? (
                  <>
                    <Spinner label="Saving" />
                    Saving…
                  </>
                ) : (
                  'Save changes'
                )}
              </button>
            </div>
          </section>

          {/* --------------------------------------------- document + review -- */}
          <div className="stack">
            <section className="card stack" aria-labelledby="document-heading">
              <h2 id="document-heading" className="card__title">
                Identity document
              </h2>
              <IdDocumentPreview
                registrationId={id}
                hasDocument={registration.hasIdDocument}
                deletedAt={registration.idDocumentDeletedAt}
              />
            </section>

            <section className="card stack" aria-labelledby="review-heading">
              <h2 id="review-heading" className="card__title">
                Review
              </h2>

              {registration.hasIdDocument && (
                <Alert tone="warning">
                  Approving, checking in or rejecting permanently deletes the guest's ID photo.
                </Alert>
              )}

              <div className="filters" role="group" aria-label="Set registration status">
                {DECISIONS.map((decision) => (
                  <button
                    key={decision}
                    type="button"
                    className="chip"
                    aria-pressed={decision === registration.status}
                    onClick={() => decide(decision)}
                    disabled={saving}
                  >
                    {STATUS_LABELS[decision]}
                  </button>
                ))}
              </div>

              <dl className="definition">
                <dt>Consent</dt>
                <dd>{registration.consentGiven ? 'Given by guest' : 'Not recorded'}</dd>
                {registration.reviewedAt && (
                  <>
                    <dt>Reviewed</dt>
                    <dd>{new Date(registration.reviewedAt).toLocaleString()}</dd>
                  </>
                )}
              </dl>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
