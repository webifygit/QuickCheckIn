import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api, { API_BASE_URL } from '../api/client';

const STATUS_FLOW = ['PENDING', 'APPROVED', 'CHECKED_IN', 'REJECTED'];

export default function RegistrationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [registration, setRegistration] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function load(signal) {
    try {
      const { data } = await api.get(`/api/registrations/${id}`, { signal });
      if (signal.aborted) return;
      setRegistration(data);
      setForm(data);
    } catch (err) {
      // A superseded load. Its data is stale by definition, and dropping it
      // into the form would wipe out anything typed while it was in flight.
      if (signal.aborted) return;
      if (err.response?.status === 401) {
        navigate('/login');
        return;
      }
      setError('Failed to load registration');
    }
  }

  function updateField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSave(overrides = {}) {
    setSaving(true);
    setError('');
    try {
      const payload = { ...form, ...overrides };
      const { data } = await api.patch(`/api/registrations/${id}`, payload);
      setRegistration(data);
      setForm(data);
    } catch (err) {
      setError('Failed to save changes');
    } finally {
      setSaving(false);
    }
  }

  if (error && !registration) return <div className="page"><p className="error">{error}</p></div>;
  if (!registration || !form) return <div className="page"><p>Loading…</p></div>;

  const imageUrl = registration.idDocumentImagePath
    ? `${API_BASE_URL}/${registration.idDocumentImagePath.replace(/\\/g, '/')}`
    : null;

  return (
    <div className="page">
      <Link to="/dashboard">&larr; Back to dashboard</Link>
      <h1>{registration.fullName}</h1>

      <div className="detail-grid">
        <div className="card">
          <h2>Details</h2>
          <label>
            Full name
            <input value={form.fullName || ''} onChange={(e) => updateField('fullName', e.target.value)} />
          </label>
          <label>
            Date of birth
            <input value={form.dob || ''} onChange={(e) => updateField('dob', e.target.value)} />
          </label>
          <label>
            Gender
            <input value={form.gender || ''} onChange={(e) => updateField('gender', e.target.value)} />
          </label>
          <label>
            Nationality
            <input value={form.nationality || ''} onChange={(e) => updateField('nationality', e.target.value)} />
          </label>
          <label>
            ID type
            <select value={form.idType || 'AADHAAR'} onChange={(e) => updateField('idType', e.target.value)}>
              <option value="AADHAAR">Aadhaar</option>
              <option value="PASSPORT">Passport</option>
              <option value="DRIVING_LICENSE">Driving License</option>
              <option value="VOTER_ID">Voter ID</option>
              <option value="OTHER">Other</option>
            </select>
          </label>
          <label>
            ID number
            <input value={form.idNumber || ''} onChange={(e) => updateField('idNumber', e.target.value)} />
          </label>
          <label>
            Address
            <textarea value={form.address || ''} onChange={(e) => updateField('address', e.target.value)} />
          </label>
          <label>
            Phone
            <input value={form.phone || ''} onChange={(e) => updateField('phone', e.target.value)} />
          </label>
          <label>
            Email
            <input value={form.email || ''} onChange={(e) => updateField('email', e.target.value)} />
          </label>
          <label>
            Vehicle number
            <input value={form.vehicleNumber || ''} onChange={(e) => updateField('vehicleNumber', e.target.value)} />
          </label>
          <label>
            Purpose of visit
            <input value={form.purposeOfVisit || ''} onChange={(e) => updateField('purposeOfVisit', e.target.value)} />
          </label>
          <label>
            Number of guests
            <input
              type="number"
              min="1"
              value={form.numberOfGuests || 1}
              onChange={(e) => updateField('numberOfGuests', e.target.value)}
            />
          </label>

          {error && <p className="error">{error}</p>}
          <button onClick={() => handleSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>

        <div className="card">
          <h2>Uploaded ID document</h2>
          {imageUrl ? (
            <img src={imageUrl} alt="Uploaded ID document" className="doc-preview" />
          ) : (
            <p>No document uploaded.</p>
          )}

          <h2>Status</h2>
          <p>
            Current: <span className={`status status-${registration.status.toLowerCase()}`}>{registration.status}</span>
          </p>
          <div className="status-buttons">
            {STATUS_FLOW.map((s) => (
              <button
                key={s}
                className={s === registration.status ? 'chip active' : 'chip'}
                onClick={() => handleSave({ status: s })}
                disabled={saving}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
