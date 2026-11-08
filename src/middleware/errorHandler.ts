import type { ErrorRequestHandler, RequestHandler } from 'express';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
export const notFound: RequestHandler = (_req, res) => { res.status(404).json({ error: 'API route not found.' }); };
export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) { next(error); return; }
  if (error?.type === 'entity.parse.failed') { res.status(400).json({ error: 'Request body must contain valid JSON.' }); return; }
  if (error?.type === 'entity.too.large') { res.status(413).json({ error: 'Request body is too large.' }); return; }
  if (respondToFirestoreResourceExhausted(res, error)) return;
  console.error('Unhandled API error:', error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
};
