import { useState } from 'react';
import api from '../api/client';

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

export default function RegisterForm() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [file, setFile] = useState(null);
  const [idDocumentImagePath, setIdDocumentImagePath] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const [scanFailed, setScanFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  function updateField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleFileChange(e) {
    const selected = e.target.files[0];
    if (!selected) return;
    setFile(selected);
    setExtracting(true);
    setScanMessage('');
    setScanFailed(false);
    setError('');

    try {
      const body = new FormData();
      body.append('document', selected);
      const { data } = await api.post('/api/document/scan', body, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setIdDocumentImagePath(data.imagePath || null);

      if (data.fields) {
        setForm((f) => ({
          ...f,
          fullName: data.fields.fullName || f.fullName,
          dob: data.fields.dob || f.dob,
          gender: data.fields.gender || f.gender,
          idNumber: data.fields.idNumber || f.idNumber,
          address: data.fields.address || f.address,
        }));
        setScanMessage('Details filled in from your Aadhaar QR code — please check them and correct anything that looks wrong.');
      } else {
        setScanFailed(true);
        setScanMessage(data.message || "Couldn't read this image. Please fill the form in yourself.");
      }
    } catch (err) {
      setScanFailed(true);
      setScanMessage("Couldn't read this image. Please fill the form in yourself.");
    } finally {
      setExtracting(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!form.consentGiven) {
      setError('Please confirm the declaration before submitting.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/api/registrations', {
        ...form,
        idDocumentImagePath,
      });
      setSubmitted(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="page page-narrow">
        <div className="card">
          <h1>Thank you!</h1>
          <p>Your registration has been submitted. Front desk staff will confirm your check-in shortly.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-narrow">
      <h1>Guest Registration</h1>
      <form onSubmit={handleSubmit} className="card">
        <label>
          Upload a photo of your Aadhaar card
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFileChange} />
          <span className="hint">
            Make sure the QR code on the card is clearly visible — we'll fill in the form for you.
            Using a different ID? Upload it anyway and just fill in the details below.
          </span>
        </label>
        {extracting && <p>Reading your card…</p>}
        {scanMessage && <p className={scanFailed ? 'error' : 'hint'}>{scanMessage}</p>}

        <label>
          Full name *
          <input value={form.fullName} onChange={(e) => updateField('fullName', e.target.value)} required />
        </label>
        <label>
          Date of birth
          <input placeholder="DD/MM/YYYY" value={form.dob} onChange={(e) => updateField('dob', e.target.value)} />
        </label>
        <label>
          Gender
          <select value={form.gender} onChange={(e) => updateField('gender', e.target.value)}>
            <option value="">Select…</option>
            <option value="MALE">Male</option>
            <option value="FEMALE">Female</option>
            <option value="TRANSGENDER">Transgender</option>
          </select>
        </label>
        <label>
          Nationality
          <input value={form.nationality} onChange={(e) => updateField('nationality', e.target.value)} />
        </label>
        <label>
          ID type
          <select value={form.idType} onChange={(e) => updateField('idType', e.target.value)}>
            <option value="AADHAAR">Aadhaar</option>
            <option value="PASSPORT">Passport</option>
            <option value="DRIVING_LICENSE">Driving License</option>
            <option value="VOTER_ID">Voter ID</option>
            <option value="OTHER">Other</option>
          </select>
        </label>
        <label>
          ID number
          <input value={form.idNumber} onChange={(e) => updateField('idNumber', e.target.value)} />
          {form.idType === 'AADHAAR' && (
            <span className="hint">For Aadhaar we only keep the last 4 digits.</span>
          )}
        </label>
        <label>
          Address
          <textarea value={form.address} onChange={(e) => updateField('address', e.target.value)} />
        </label>
        <label>
          Phone *
          <input value={form.phone} onChange={(e) => updateField('phone', e.target.value)} required />
        </label>
        <label>
          Email
          <input type="email" value={form.email} onChange={(e) => updateField('email', e.target.value)} />
        </label>
        <label>
          Check-in date
          <input type="date" value={form.checkInDate} onChange={(e) => updateField('checkInDate', e.target.value)} />
        </label>
        <label>
          Check-out date
          <input type="date" value={form.checkOutDate} onChange={(e) => updateField('checkOutDate', e.target.value)} />
        </label>
        <label>
          Number of guests
          <input
            type="number"
            min="1"
            value={form.numberOfGuests}
            onChange={(e) => updateField('numberOfGuests', e.target.value)}
          />
        </label>
        <label>
          Purpose of visit
          <input value={form.purposeOfVisit} onChange={(e) => updateField('purposeOfVisit', e.target.value)} />
        </label>
        <label>
          Vehicle number (optional)
          <input value={form.vehicleNumber} onChange={(e) => updateField('vehicleNumber', e.target.value)} />
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.consentGiven}
            onChange={(e) => updateField('consentGiven', e.target.checked)}
          />
          I confirm the above details are accurate and consent to their use for hotel guest registration.
        </label>

        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting || extracting}>
          {submitting ? 'Submitting…' : 'Submit registration'}
        </button>
      </form>
    </div>
  );
}
