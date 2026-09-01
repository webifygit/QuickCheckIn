// A dedicated staff account and a marker on every row the suite creates, so a
// run can clean up after itself without touching real data.
export const E2E_STAFF = {
  email: 'e2e-staff@test.local',
  password: 'E2eStaffPassword123!',
  name: 'E2E Front Desk',
};

export const E2E_MARKER = 'e2e-test-run';

// baseURL points at the Vite dev server, so API-level assertions need the API's
// own origin - otherwise the SPA fallback answers and every check passes.
export const API_URL = process.env.E2E_API_URL || 'http://localhost:4000';
