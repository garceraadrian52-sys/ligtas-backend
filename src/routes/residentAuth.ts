import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { UserRecord } from 'firebase-admin/auth';
import { auth, db } from '../config/firebaseAdmin';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { validDocumentId } from '../services/inputValidation';

const router = Router();
const invalidLogin = 'Invalid mobile number or password. Try your email or recover an existing SMS account.';
const duplicatePhone = 'This mobile number is already registered. Sign in or recover your account.';

function normalizeMobile(value: unknown) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const match = /^(?:\+?63|0)?(9\d{9})$/.exec(value.trim().replace(/[\s()-]/g, ''));
  return match?.[1] ?? null;
}

function phoneIndex(phone: string) {
  return db.doc(`residentLoginPhones/${phone}`);
}

async function lookupAuth(read: Promise<UserRecord>): Promise<UserRecord | null> {
  try { return await read; }
  catch (error) {
    if ((error as { code?: string }).code === 'auth/user-not-found') return null;
    throw error;
  }
}

function isResident(role: unknown) {
  return typeof role === 'string' && role.trim().toLowerCase() === 'resident';
}

async function legacyProfiles(phone: string) {
  // Earlier clients stored the normalized local number or the SMS E.164 number.
  const formats: (string | number)[] = [Number(phone), Number(`63${phone}`)];
  const area = phone.slice(0, 3);
  const middle = phone.slice(3, 6);
  const end = phone.slice(6);
  for (const prefix of ['', '0', '63', '+63']) {
    const start = prefix + area;
    formats.push(prefix + phone, `${start} ${middle} ${end}`, `${start}-${middle}-${end}`);
    if (prefix === '63' || prefix === '+63') {
      formats.push(`${prefix} ${phone}`, `${prefix} ${area} ${middle} ${end}`, `${prefix} ${area}-${middle}-${end}`,
        `${prefix}-${area}-${middle}-${end}`, `(${prefix}) ${area} ${middle} ${end}`);
    }
  }
  const users = db.collection('users');
  const [current, older] = await Promise.all([
    users.where('phone', 'in', formats).get(),
    users.where('phoneNumber', 'in', formats).get(),
  ]);
  const profiles = new Map(current.docs.map(profile => [profile.id, profile]));
  for (const profile of older.docs) {
    const primary = profile.get('phone');
    if (!normalizeMobile(typeof primary === 'number' ? String(primary) : primary)) profiles.set(profile.id, profile);
  }
  return [...profiles.values()].filter(profile => isResident(profile.get('role')));
}

async function phoneAccounts(phone: string) {
  return Promise.all([
    lookupAuth(auth.getUserByPhoneNumber(`+63${phone}`)),
    lookupAuth(auth.getUserByEmail(`${phone}@ligtas.local`)),
  ]);
}

async function resolvePhoneUsers(phone: string) {
  const index = await phoneIndex(phone).get();
  const indexedUid = index.get('uid');
  if (typeof indexedUid === 'string') return [await lookupAuth(auth.getUser(indexedUid))];
  const [accounts, legacy] = await Promise.all([phoneAccounts(phone), legacyProfiles(phone)]);
  const known = new Map(accounts.flatMap(account => account ? [[account.uid, account] as const] : []));
  const otherUids = legacy.map(profile => profile.id).filter(uid => !known.has(uid));
  // A shared legacy number is safe only if exactly one candidate can prove
  // the supplied password. Bound the work done for corrupted or shared data.
  if (known.size + otherUids.length > 4) return [];
  return [...known.values(), ...await Promise.all(otherUids.map(uid => lookupAuth(auth.getUser(uid))))];
}

async function verifyPassword(account: UserRecord, password: string, origin: string, apiKey: string) {
  const verified = await fetch(`${origin}/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(12_000),
    body: JSON.stringify({ email: account.email, password, returnSecureToken: true }),
  });
  if (verified.status >= 500) throw new Error('Identity service unavailable');
  const credentials = await verified.json() as { localId?: string; idToken?: string; mfaPendingCredential?: string; error?: { message?: string } };
  const code = credentials.error?.message ?? '';
  if (verified.status === 429 || code.startsWith('TOO_MANY_ATTEMPTS')) return 'throttled';
  if (verified.status === 403 || /^(API_KEY_INVALID|PROJECT_NOT_FOUND|OPERATION_NOT_ALLOWED|CONFIGURATION_NOT_FOUND)\b/.test(code)) {
    throw new Error('Identity service configuration unavailable');
  }
  return verified.ok && credentials.localId === account.uid && credentials.idToken && !credentials.mfaPendingCredential
    ? 'verified' : 'rejected';
}

const attempts = new Map<string, { count: number; expires: number }>();
function withinLimit(key: string, max: number) {
  const now = Date.now();
  const existing = attempts.get(key);
  if (existing && existing.expires > now) return ++existing.count <= max;
  if (attempts.size >= 4096) {
    for (const [entry, value] of attempts) if (value.expires <= now) attempts.delete(entry);
    if (attempts.size >= 4096) return false;
  }
  attempts.set(key, { count: 1, expires: now + 60_000 });
  return true;
}

router.post('/register', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { name, barangayId, email: rawEmail, password } = req.body ?? {};
  const phone = normalizeMobile(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid Philippine mobile number.' });
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || typeof barangayId !== 'string' || !validDocumentId(barangayId)) {
    return res.status(400).json({ error: 'Enter your name and select your barangay.' });
  }
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if ((rawEmail != null && typeof rawEmail !== 'string') || (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith('@ligtas.local')))) {
    return res.status(400).json({ error: 'Enter a valid email address or leave it blank.' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 4096) {
    return res.status(400).json({ error: 'Enter a password with at least 8 characters.' });
  }
  if (!withinLimit(`register:ip:${req.ip}`, 30) || !withinLimit(`register:phone:${phone}`, 5)) {
    return res.set('Retry-After', '60').status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  const index = phoneIndex(phone);
  const uid = randomUUID();
  try {
    const [barangay, existing] = await Promise.all([db.doc(`barangays/${barangayId}`).get(), index.get()]);
    if (!barangay.exists) return res.status(400).json({ error: 'Select a valid barangay.' });
    if (existing.exists) return res.status(409).json({ error: duplicatePhone });
    const [accounts, profiles] = await Promise.all([phoneAccounts(phone), legacyProfiles(phone)]);
    if (accounts.some(Boolean) || profiles.length) return res.status(409).json({ error: duplicatePhone });

    // Keep the supplied number as an identifier only. Adding it to Firebase Auth
    // as a phone credential would incorrectly treat it as verified.
    await auth.createUser({ uid, email: email || `${phone}@ligtas.local`, password, displayName: name.trim() });
    const profile = db.doc(`users/${uid}`);
    try {
      await db.runTransaction(async transaction => {
        if ((await transaction.get(index)).exists) throw new Error('PHONE_ALREADY_REGISTERED');
        const now = new Date();
        transaction.create(profile, {
          name: name.trim(), displayName: name.trim(), phone, email, barangayId,
          role: 'RESIDENT', householdId: null, emailVerificationRequired: Boolean(email), createdAt: now, updatedAt: now,
        });
        transaction.create(index, { uid, createdAt: now });
      });
    } catch (error) {
      // A response can be lost after commit. Confirm ownership before cleanup.
      const saved = await index.get();
      if (saved.get('uid') !== uid) {
        await auth.deleteUser(uid);
        if (saved.exists) return res.status(409).json({ error: duplicatePhone });
        throw error;
      }
    }
    return res.status(201).json({ data: { uid } });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'auth/email-already-exists') {
      return res.status(409).json({ error: email ? 'That email address is already registered.' : duplicatePhone });
    }
    if (code === 'auth/invalid-password' || code === 'auth/invalid-email') {
      return res.status(400).json({ error: 'Check your email address and password.' });
    }
    if (respondToFirestoreResourceExhausted(res, error)) return;
    console.error('Resident registration unavailable:', code ?? 'unknown');
    return res.status(503).json({ error: 'Account setup is temporarily unavailable. Try signing in before registering again.' });
  }
});

router.post('/recover/check', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const phone = normalizeMobile(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid Philippine mobile number.' });
  if (!withinLimit(`recovery:ip:${req.ip}`, 60) || !withinLimit(`recovery:phone:${phone}`, 5)) {
    return res.set('Retry-After', '60').status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  const unavailable = 'SMS password setup is unavailable for this number. Try email sign-in or contact LigTAS support.';
  try {
    const account = await lookupAuth(auth.getUserByPhoneNumber(`+63${phone}`));
    if (!account || account.disabled || account.email || account.providerData.some(provider => provider.providerId === 'password')) {
      return res.status(404).json({ error: unavailable });
    }
    const profile = await db.doc(`users/${account.uid}`).get();
    if (!isResident(profile.get('role')) || profile.get('disabled') === true) return res.status(404).json({ error: unavailable });
    // Eligibility alone grants no authentication or password change.
    return res.json({ data: { eligible: true } });
  } catch (error) {
    if (respondToFirestoreResourceExhausted(res, error)) return;
    console.error('Resident recovery check unavailable:', (error as { code?: string }).code ?? 'unknown');
    return res.status(503).json({ error: 'Account recovery is temporarily unavailable. Please try again.' });
  }
});

router.post('/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const phone = normalizeMobile(req.body?.phone);
  const password = req.body?.password;
  if (!phone || typeof password !== 'string' || !password || password.length > 4096) {
    return res.status(400).json({ error: 'Enter a valid mobile number and password.' });
  }
  if (!withinLimit(`login:ip:${req.ip}`, 180) || !withinLimit(`login:phone:${phone}`, 15)) {
    return res.set('Retry-After', '60').status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  const emulator = process.env.NODE_ENV !== 'production' && process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!apiKey && !emulator) return res.status(503).json({ error: 'Mobile number sign-in is temporarily unavailable.' });
  try {
    const accounts = (await resolvePhoneUsers(phone)).filter((account): account is UserRecord => Boolean(account?.email && !account.disabled));
    const origin = emulator
      ? `http://${emulator}/identitytoolkit.googleapis.com`
      : 'https://identitytoolkit.googleapis.com';
    const candidates = await Promise.all(accounts.map(async account => {
      const profile = await db.doc(`users/${account.uid}`).get();
      if (!isResident(profile.get('role')) || profile.get('disabled') === true) return { account, state: 'rejected' };
      return { account, state: await verifyPassword(account, password, origin, apiKey || 'demo-key') };
    }));
    if (candidates.some(candidate => candidate.state === 'throttled')) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    const matches = candidates.filter(candidate => candidate.state === 'verified');
    if (matches.length !== 1) return res.status(401).json({ error: invalidLogin });
    const token = await auth.createCustomToken(matches[0].account.uid);
    return res.json({ data: { token } });
  } catch (error) {
    if (respondToFirestoreResourceExhausted(res, error)) return;
    console.error('Resident mobile login unavailable:', (error as { code?: string }).code ?? 'unknown');
    return res.status(503).json({ error: 'Mobile number sign-in is temporarily unavailable. Please try again.' });
  }
});

export default router;
