const MAX_PROFILE_PHOTO_LENGTH = 300_000;
const INLINE_PROFILE_PHOTO = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isValidProfilePhoto(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROFILE_PHOTO_LENGTH) return false;
  if (INLINE_PROFILE_PHOTO.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** Firebase Auth accepts hosted photo URLs; inline images stay in Firestore. */
export function firebaseAuthPhotoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('https://')) return undefined;
  return value;
}

export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
