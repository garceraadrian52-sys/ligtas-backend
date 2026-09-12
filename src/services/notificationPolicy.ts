import { createHash } from 'node:crypto';

function normalize(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/^barangay[_\s-]*/, '')
    .replace(/[_\s-]+/g, '')
    .replace(/1st/g, 'first')
    .replace(/2nd/g, 'second');
}

export function published(data: any, now = Date.now()) {
  const expires = data?.expiresAt?.toMillis?.() ?? (data?.expiresAt ? new Date(data.expiresAt).getTime() : null);
  return ['active', 'published', 'monitoring'].includes(String(data?.status ?? '').toLowerCase())
    && (expires === null || (Number.isFinite(expires) && expires > now));
}

export function inArea(data: any, user: any) {
  if (['LGU_ADMIN', 'lgu_mdrrmo', 'lguAdmin', 'mdrrmo'].includes(user.role) || data.coverageArea === 'municipality' || data.locationScope?.type === 'municipality') return true;
  const values = data.locationScope?.barangayIds ?? data.barangayIds ?? (data.barangayId ? [data.barangayId] : []);
  if (!Array.isArray(values)) return false;
  if (values.length === 0) return data.coverageArea !== 'barangay' && data.locationScope?.type !== 'barangay';
  return values.some((id: string) => normalize(id) !== '' && normalize(id) === normalize(user.barangayId));
}

export function kindForAlert(data: any) {
  return /evac/i.test(`${data.category ?? ''} ${data.alertType ?? ''}`) ? 'evacuation' : 'alert';
}

export function enabled(user: any, kind: string) {
  if (user.disabled === true) return false;
  const key = ({ alert: 'Flood Alerts', evacuation: 'Evacuation Updates', report: 'Report Updates', household: 'Household Updates' } as Record<string, string>)[kind];
  return user.notificationPreferences?.[key] !== false;
}

export function retryDelay(attempt: number) {
  return Math.min(3600000, 60000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));
}

export function alertRevision(id: string, alert: any) {
  const fields = [id, alert.title ?? null, alert.message ?? alert.description ?? null,
    alert.priority ?? null, alert.category ?? null, alert.alertType ?? null,
    alert.coverageArea ?? null, alert.locationScope ?? null, alert.barangayIds ?? null,
    alert.barangayId ?? null, alert.publishedAt ?? null, alert.expiresAt ?? null];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}