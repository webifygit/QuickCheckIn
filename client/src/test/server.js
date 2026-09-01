import { setupServer } from 'msw/node';

// Requests go through the real axios client (interceptor included) and are
// intercepted at the network layer, so tests assert on real request/response
// shapes rather than on a hand-mocked module.
export const server = setupServer();
