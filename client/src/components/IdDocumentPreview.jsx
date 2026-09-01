import { useEffect, useState } from 'react';
import api, { describeError } from '../api/client';
import Alert from '../components/Alert';

// The ID image is not a public URL - it is streamed through an authenticated
// route. So it cannot go straight into an <img src>; it has to be fetched with
// the staff token attached and turned into a blob URL.
export default function IdDocumentPreview({ registrationId, hasDocument, deletedAt }) {
  const [objectUrl, setObjectUrl] = useState(null);
  // Starting at 'loading' when there is something to load keeps the first paint
  // honest and avoids a state write during the effect.
  const [state, setState] = useState(() => (hasDocument ? 'loading' : 'idle'));
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!hasDocument) return undefined;

    const controller = new AbortController();
    let created = null;

    async function load() {
      try {
        const { data } = await api.get(`/api/registrations/${registrationId}/document`, {
          responseType: 'blob',
          signal: controller.signal,
        });
        created = URL.createObjectURL(data);
        setObjectUrl(created);
        setState('ready');
      } catch (err) {
        const described = describeError(err, 'Could not load the ID image.');
        if (described.cancelled) return;
        setMessage(described.message);
        setState('error');
      }
    }

    load();

    return () => {
      controller.abort();
      // Blob URLs are held by the document until explicitly released.
      if (created) URL.revokeObjectURL(created);
    };
  }, [registrationId, hasDocument]);

  if (deletedAt) {
    return (
      <Alert tone="info">
        The ID photo was deleted on {new Date(deletedAt).toLocaleDateString()}, once this
        registration was reviewed.
      </Alert>
    );
  }

  if (!hasDocument) {
    return <p className="field__hint">No ID photo was uploaded with this registration.</p>;
  }

  if (state === 'loading') {
    return <div className="skeleton" style={{ height: 180 }} />;
  }

  if (state === 'error') {
    return <Alert tone="warning">{message}</Alert>;
  }

  return <img src={objectUrl} alt="Uploaded identity document" className="doc-preview" />;
}
