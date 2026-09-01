import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../test/server.js';
import api from './client.js';
import { API } from '../test/utils.jsx';

describe('api client', () => {
  it('attaches the staff token to outgoing requests', async () => {
    let seen;
    server.use(
      http.get(`${API}/api/registrations`, ({ request }) => {
        seen = request.headers.get('authorization');
        return HttpResponse.json([]);
      })
    );
    localStorage.setItem('staffToken', 'a-real-token');

    await api.get('/api/registrations');

    expect(seen).toBe('Bearer a-real-token');
  });

  it('sends no authorization header when nobody is signed in', async () => {
    let seen = 'unset';
    server.use(
      http.post(`${API}/api/registrations`, ({ request }) => {
        seen = request.headers.get('authorization');
        return HttpResponse.json({}, { status: 201 });
      })
    );

    await api.post('/api/registrations', {});

    expect(seen).toBeNull();
  });
});
