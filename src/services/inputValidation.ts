export const validText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export const validDocumentId = (value: unknown): value is string => validText(value, 1500) && !value.includes('/') && value !== '.' && value !== '..';
export function validCoordinatePair(latitude: unknown, longitude: unknown) {
  if (latitude == null && longitude == null) return true;
  return typeof latitude === 'number' && Number.isFinite(latitude) && Math.abs(latitude) <= 90 && typeof longitude === 'number' && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
}
