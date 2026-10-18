import request from 'supertest';

import { createApp } from '../src/app.js';

describe('health endpoint', () => {
  it('reports that the API process is healthy', async () => {
    const response = await request(createApp({ logLevel: 'silent' })).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: 'ok' } });
  });

  it('returns the standard error shape for an unknown route', async () => {
    const response = await request(createApp({ logLevel: 'silent' })).get('/api/v1/unknown');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'The requested resource is unavailable.',
      },
    });
  });

  it('normalizes malformed JSON as a client error', async () => {
    const response = await request(createApp({ logLevel: 'silent' }))
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{broken');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
  });
});
