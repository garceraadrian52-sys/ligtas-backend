import boundary from '../config/balagtasBoundary.json';
import { recordedMillis } from './reportAnalytics';

export const BALAGTAS_LOCATION = { name: 'Balagtas, Bulacan', latitude: 14.8187, longitude: 120.9054, timeZone: 'Asia/Manila' };
type Point = { latitude: number; longitude: number };
export function isInBalagtas(point: Point): boolean {
  if (![point.latitude, point.longitude].every(Number.isFinite)) return false;
  let inside = false;
  const { latitude: y, longitude: x } = point;
  for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
    const a = boundary[i], b = boundary[j];
    const cross = (x - a.longitude) * (b.latitude - a.latitude) - (y - a.latitude) * (b.longitude - a.longitude);
    if (Math.abs(cross) < 1e-12 && x >= Math.min(a.longitude,b.longitude) && x <= Math.max(a.longitude,b.longitude) && y >= Math.min(a.latitude,b.latitude) && y <= Math.max(a.latitude,b.latitude)) return true;
    if ((a.latitude > y) !== (b.latitude > y) && x < (b.longitude-a.longitude)*(y-a.latitude)/(b.latitude-a.latitude)+a.longitude) inside = !inside;
  }
  return inside;
}

const hour = 3600000;
const floodLabels = ['Ankle deep', 'Knee deep', 'Waist deep', 'Chest deep'];
const roadLabels = ['None', 'Gutter Level', 'Gutter Deep', 'Knee Level', 'Above Knee Level'];
function depth(value: unknown, road: boolean): number | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (road) { const index=roadLabels.findIndex(label=>label.toLowerCase()===text); return index<0?null:index; }
  const index = ['ankle','knee','waist','chest'].findIndex(label => text === label || text === `${label} deep` || text === `${label}-deep`);
  return index < 0 ? null : index + 1;
}
function reportPoint(report: Record<string, any>): Point | null {
  const p = report.coordinates || report.locationPoint || report;
  const latitude = report.latitude ?? p.latitude ?? p.lat ?? p._latitude;
  const longitude = report.longitude ?? p.longitude ?? p.lng ?? p._longitude;
  return typeof latitude === 'number' && typeof longitude === 'number' && Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}
const timeLabel = (time: number) => new Date(time).toLocaleTimeString('en-PH', {timeZone:'Asia/Manila',hour:'2-digit',minute:'2-digit',hour12:false});

function buildSeries(reports: Record<string, any>[], now: number, road: boolean) {
  const labels=road?roadLabels:floodLabels;
  const minimum=road?0:1, maximum=4;
  const start = now - 24 * hour;
  const bins = Array.from({length:24},(_,index)=>({ startAt:new Date(start+index*hour).toISOString(), endAt:new Date(start+(index+1)*hour).toISOString(), level:null as number|null, label:null as string|null, count:0 }));
  const excluded = { outside:0, missingCoordinates:0, missingDepth:0, missingTime:0 };
  for (const report of reports) {
    const status = String(report.status || report.verification || '').toLowerCase();
    if (!['verified','approved','resolved'].includes(status) && !(!['pending','rejected','denied','resolved'].includes(status) && ['verified','approved'].includes(String(report.verification).toLowerCase()))) continue;
    const time = recordedMillis(report.observedAt) ?? recordedMillis(report.submittedAt) ?? recordedMillis(report.createdAt);
    if (time === null) { excluded.missingTime++; continue; }
    if (time < start || time > now) continue;
    const point = reportPoint(report);
    if (!point) { excluded.missingCoordinates++; continue; }
    if (!isInBalagtas(point)) { excluded.outside++; continue; }
    const value = depth(road?report.floodingLevel:report.waterLevel,road);
    if (value === null) { excluded.missingDepth++; continue; }
    const bin = bins[Math.min(23,Math.floor((time-start)/hour))];
    bin.count++;
    if (bin.level === null || value > bin.level) { bin.level=value; bin.label=labels[value-minimum]; }
  }
  const points = bins.flatMap((bin,index)=>bin.level===null?[]:[{x:Math.round(100+(index+.5)/24*800),y:Math.round(192-(bin.level-minimum)/(maximum-minimum)*174),index,label:bin.label!,count:bin.count,title:`${timeLabel(Date.parse(bin.startAt))}–${timeLabel(Date.parse(bin.endAt))} Manila: ${bin.label}; ${bin.count} reports`}]);
  const segments:string[]=[];
  for (const p of points) {
    const previous=points[points.indexOf(p)-1];
    if (previous && previous.index+1===p.index) segments[segments.length-1]+=` L${p.x} ${p.y}`;
    else segments.push(`M${p.x} ${p.y}`);
  }
  return { source:'Verified report observations', kind:'reported-depth', id:road?'road':'flood', label:road?'Road flooding categories':'Flood report depths', location:BALAGTAS_LOCATION, startAt:new Date(start).toISOString(), endAt:new Date(now).toISOString(),
    count:bins.reduce((total,bin)=>total+bin.count,0), bins, excluded,
    chart:{ points, segments, yTicks:labels.map((label,index)=>({label,y:Math.round(192-index/(labels.length-1)*174)})), xTicks:Array.from({length:9},(_,index)=>({label:timeLabel(start+index*3*hour),x:100+index*100})) },
    note:`Highest verified ${road?'road-flooding category':'flood-depth category'} in each hour, using coordinates inside Balagtas. Categories are not metre measurements. Blank hours mean no observations, not zero flooding.` };
}

export function buildBalagtasWaterTrend(reports: Record<string, any>[], now = Date.now()) {
  const series=[buildSeries(reports,now,false),buildSeries(reports,now,true)];
  const preferred=series[0].count?series[0]:series[1];
  return {...preferred,defaultSeries:preferred.id,series};
}
