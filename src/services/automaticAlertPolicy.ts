import { createHash } from 'node:crypto';
import { isInBalagtas } from './balagtasMonitoring';
import { recordedMillis } from './reportAnalytics';

export const automaticBarangays: Record<string, string> = {
  barangay_borol_1st: 'Borol 1st', barangay_borol_2nd: 'Borol 2nd', barangay_dalig: 'Dalig',
  barangay_longos: 'Longos', barangay_panginay: 'Panginay', barangay_pulong_gubat: 'Pulong Gubat',
  barangay_san_juan: 'San Juan', barangay_santol: 'Santol', barangay_wawa: 'Wawa',
};
export const automaticReportId = (id: string) => 'automatic_report_' + createHash('sha256').update(id).digest('hex');
const clean = (value: unknown, length = 250) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const recommendations = ['Avoid floodwater and affected roads.', 'Follow verified barangay and LGU instructions.', 'Prepare essentials and assist vulnerable household members when safe.'];
const normalizeArea = (value: string) => value.toLowerCase().replace(/^barangay[_\s-]*/, '').replace(/[_\s-]+/g, '');

export function automaticReportAlert(id: string, report: Record<string, any>, now = Date.now()) {
  const status = String(report.status ?? report.verification ?? '').toLowerCase();
  if (['pending', 'rejected', 'denied', 'resolved'].includes(status) || String(report.verification ?? report.status).toLowerCase() !== 'verified') return null;
  const observed = recordedMillis(report.observedAt) ?? recordedMillis(report.submittedAt) ?? recordedMillis(report.createdAt);
  // Old edits and re-verifications must not revive historical incidents.
  if (observed === null || observed > now + 60000 || now - observed >= 24 * 3600000) return null;
  const point = report.locationPoint || report.coordinates || report;
  const latitude = report.latitude ?? point.latitude ?? point._latitude;
  const longitude = report.longitude ?? point.longitude ?? point._longitude;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !isInBalagtas({ latitude, longitude })) return null;
  const barangayId = Object.keys(automaticBarangays).find(area => normalizeArea(area) === normalizeArea(String(report.barangayId || '')));
  if (!barangayId) return null; // Never widen an unknown area to the whole municipality.
  const kind = String(report.type || report.reportType || '').toLowerCase();
  const road = kind.includes('road'), flood = kind.includes('flood');
  const roadStatus = clean(report.roadStatus).toLowerCase();
  const closed = /not passable|closed/.test(roadStatus), limited = /limited/.test(roadStatus);
  if (!flood && !(road && (closed || limited))) return null;
  const location = clean(report.location || report.roadName) || automaticBarangays[barangayId];
  const water = clean(report.waterLevel || report.floodingLevel, 80);
  const priority = closed || /waist|chest|above knee/i.test(water) ? 'Critical' : 'High';
  const category = flood ? 'Flood Warning' : 'Road Advisory';
  const message = [
    `Verified ${flood ? 'flooding' : closed ? 'road closure' : 'limited road access'} at ${location}, ${automaticBarangays[barangayId]}, Balagtas.`,
    water ? `Reported water level: ${water}.` : '', clean(report.description, 500),
    'Avoid the affected area and follow barangay/LGU instructions.',
  ].filter(Boolean).join(' ');
  return { title: `${flood ? 'Flood warning' : closed ? 'Road closure' : 'Road advisory'}: ${location}`.slice(0, 160), message,
    category, alertType: category, priority, severityLevel: priority, description: message,
    coverageArea: 'barangay', barangayId, affectedAreas: [automaticBarangays[barangayId]],
    locationScope: { type: 'barangay', barangayIds: [barangayId] }, recommendations,
    source: 'LigTAS · verified report', sourceReportId: id, automatic: true, automationSource: 'verified-report',
    latitude, longitude, observedAt: new Date(observed), expiresAt: new Date(observed + 24 * 3600000) };
}

export function isUsableAutomaticWeather(weather: any, now = Date.now()) {
  const observed = recordedMillis(weather?.observedAt);
  return weather?.status === 'available' && observed !== null && observed <= now + 60000 && now - observed <= 3600000
    && Number.isInteger(weather.weatherCode) && weather.weatherCode >= 0 && weather.weatherCode <= 99
    && weather.location && isInBalagtas(weather.location);
}
export function automaticWeatherAlert(weather: any, now = Date.now()) {
  if (!isUsableAutomaticWeather(weather, now)) return null;
  const observed = recordedMillis(weather.observedAt)!;
  // WMO condition codes from Open-Meteo; these are model advisories, not evacuation orders.
  if (![65, 67, 82, 95, 96, 99].includes(weather.weatherCode)) return null;
  const message = `Open-Meteo's model estimate for Balagtas indicates ${clean(weather.condition, 80).toLowerCase()} as of ${new Date(observed).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}. This is a weather model advisory, not a measured flood level. Avoid exposed areas and floodwater, prepare essentials, and monitor official LGU/PAGASA announcements.`;
  return { title: 'Weather advisory: Balagtas', message, description: message, category: 'Weather Advisory', alertType: 'Weather Advisory',
    priority: 'High', severityLevel: 'High', coverageArea: 'municipality', barangayId: null,
    affectedAreas: ['All barangays in Balagtas'], locationScope: { type: 'municipality', barangayIds: [] }, recommendations,
    source: 'LigTAS · Open-Meteo model advisory', sourceUrl: 'https://open-meteo.com/', automatic: true,
    automationSource: 'weather-api', weatherCode: weather.weatherCode, observedAt: new Date(observed), expiresAt: new Date(observed + 2 * 3600000) };
}
