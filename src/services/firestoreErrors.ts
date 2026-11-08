import type { Response } from 'express';

export function isFirestoreResourceExhausted(error: unknown): boolean {
  const code = (error as any)?.code;
  return code === 8 || code === '8' || code === 'resource-exhausted' || code === 'RESOURCE_EXHAUSTED';
}

export function respondToFirestoreResourceExhausted(res: Response, error: unknown): boolean {
  if (!isFirestoreResourceExhausted(error)) return false;
  res.set('Retry-After', '5').status(503).json({ error: 'Firestore is temporarily busy. Please try again shortly.' });
  return true;
}
