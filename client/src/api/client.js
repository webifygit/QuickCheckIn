import axios from 'axios';

// Same origin is the default for a built bundle: whatever host served this page
// also serves the API, so requests go to relative paths and there is no CORS in
// the picture at all. That is true of every way this ships - the container, the
// single-process demo, and a serverless deployment behind one domain.
//
// Only `npm run dev` differs, where Vite serves the page on :5173 and the API
// runs separately on :4000, so the dev default points there.
//
// The previous default was localhost:4000 for every build that did not set
// VITE_API_BASE_URL explicitly. Vite inlines this at build time, so a platform
// that builds from the repo without setting it - which is the normal case -
// shipped a bundle asking every visitor's own machine for the API. Nothing
// fails at build time; it fails in the visitor's browser.
//
// `??` rather than `||` so an explicitly empty value still means same origin
// rather than falling through to the dev default.
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '');

const TOKEN_KEY = 'staffToken';
const NAME_KEY = 'staffName';

// Session state lives in localStorage so a refresh does not sign staff out.
// It is a bearer token with a 12h life, not a long-lived credential.
export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private-mode Safari and hardened browser settings can throw on access.
    return null;
  }
}

export function getStaffName() {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

export function saveSession({ token, staff }) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    if (staff?.name) localStorage.setItem(NAME_KEY, staff.name);
  } catch {
    // Nothing useful to do: the session simply will not survive a refresh.
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(NAME_KEY);
  } catch {
    // Ignore - there is nothing to clear if storage is unavailable.
  }
}

const api = axios.create({ baseURL: API_BASE_URL, timeout: 30000 });

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Turns any axios failure into the same shape the UI renders, so no component
// has to reach into err.response?.data?.error itself.
export function describeError(err, fallback = 'Something went wrong. Please try again.') {
  if (axios.isCancel?.(err) || err?.code === 'ERR_CANCELED') {
    return { message: null, fieldErrors: {}, status: null, cancelled: true };
  }

  const status = err?.response?.status ?? null;
  const data = err?.response?.data;

  if (status === 429) {
    return {
      message: data?.error || 'Too many attempts. Please wait a moment and try again.',
      fieldErrors: {},
      status,
      cancelled: false,
    };
  }

  // No response at all: the API is unreachable, or the request timed out.
  if (!err?.response) {
    return {
      message:
        err?.code === 'ECONNABORTED'
          ? 'That took too long. Check your connection and try again.'
          : 'Could not reach the server. Check your connection and try again.',
      fieldErrors: {},
      status,
      cancelled: false,
    };
  }

  return {
    message: data?.error || fallback,
    fieldErrors: data?.fieldErrors || {},
    status,
    cancelled: false,
  };
}

export default api;
export { API_BASE_URL };
