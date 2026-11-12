type RecordData = Record<string, any>;
export function dateMillis(value: any): number {
  const millis = value?.toMillis?.() ?? (value?._seconds !== undefined ? value._seconds * 1000 : value?.seconds !== undefined ? value.seconds * 1000 : new Date(value ?? NaN).getTime());
  return Number.isFinite(millis) ? millis : 0;
}
const localDay = (value: number) => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
const count = (value: unknown) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
export function summarizeDashboard(reports: RecordData[], alerts: RecordData[], centers: RecordData[], now = Date.now()) {
  const active = alerts.filter(item => ['active', 'published', 'monitoring'].includes(String(item.status).toLowerCase()) && (!item.expiresAt || dateMillis(item.expiresAt) > now));
  const seenAlerts = new Set<string>();
  const seenContent = new Set<string>();
  const recentAlerts = active
    .filter(item => item.isActive !== false && item.active !== false)
    .sort((a, b) => dateMillis(b.publishedAt ?? b.createdAt) - dateMillis(a.publishedAt ?? a.createdAt))
    .filter(item => {
      const key = String(item.id || JSON.stringify([item.title, item.message || item.description, dateMillis(item.publishedAt ?? item.createdAt)]));
      const message = item.message || item.description;
      const contentKey = item.title && message ? JSON.stringify([
        String(item.title).trim().toLowerCase(),
        String(message).trim().replace(/\s+/g, ' '),
        item.priority || item.severity || item.severityLevel,
        item.locationScope || item.affectedAreas || item.barangayIds || item.coverageArea,
      ]) : null;
      if (seenAlerts.has(key) || (contentKey && seenContent.has(contentKey))) return false;
      seenAlerts.add(key);
      if (contentKey) seenContent.add(contentKey);
      return true;
    })
    .slice(0, 3)
    .map(item => ({
      id: item.id,
      displayId: item.displayId,
      title: item.title || item.alertType || 'Alert',
      message: item.message || item.description || '',
      priority: item.priority || item.severityLevel || item.severity || 'Normal',
      severity: item.severity || item.severityLevel,
      type: item.type || item.category || item.alertType,
      status: item.status,
      publishedAt: item.publishedAt || item.createdAt || null,
      expiresAt: item.expiresAt || null,
      affectedAreas: item.affectedAreas,
      coverageArea: item.coverageArea,
      locationScope: item.locationScope,
      source: item.source,
      createdByName: item.createdByName,
      recommendations: item.recommendations,
    }));
  const centerList = centers.map(item => ({ id: item.id, name: item.name || 'Evacuation center', status: item.status || 'Unknown', occupied: count(item.currentOccupancy ?? item.occupied ?? item.occupancyCount), capacity: count(item.capacity ?? item.maxCapacity) }));
  return {
    pendingReports: reports.filter(item => String(item.verification ?? item.status).toLowerCase() === 'pending').length,
    verifiedToday: reports.filter(item => String(item.verification ?? item.status).toLowerCase() === 'verified' && dateMillis(item.verifiedAt) > 0 && localDay(dateMillis(item.verifiedAt)) === localDay(now)).length,
    totalReports: reports.length,
    activeAlerts: active.length,
    updatedAt: new Date(now).toISOString(),
    recentAlerts,
    evacuationCenters: { count: centers.length, totalOccupied: centerList.reduce((n,c)=>n+c.occupied,0), totalCapacity: centerList.reduce((n,c)=>n+c.capacity,0), centers: centerList },
  };
}
