import boundaries from '../config/barangayBoundaries.json';
import { isInBalagtas } from './balagtasMonitoring';

export class ReportLocationError extends Error { readonly status = 400; }
type Point = { latitude: number; longitude: number };
type Ring = number[][];
function ringContains(point: Point, ring: Ring): boolean {
  const x = point.longitude, y = point.latitude;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    if (Math.abs(cross) < 1e-12 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return true;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
export function resolveReportBarangay(latitude: unknown, longitude: unknown) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new ReportLocationError('Select the report location on the map before submitting.');
  }
  const point = { latitude, longitude };
  if (!isInBalagtas(point)) throw new ReportLocationError('Select a report location inside Balagtas.');
  const matches = boundaries.features.filter(feature => {
    const polygons: Ring[][] = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates as Ring[]] : feature.geometry.coordinates as unknown as Ring[][];
    return polygons.some(rings => ringContains(point, rings[0]) && !rings.slice(1).some(hole => ringContains(point, hole)));
  });
  if (matches.length !== 1) throw new ReportLocationError('The barangay at this pin could not be determined unambiguously. Move the pin inside the incident barangay and try again.');
  const feature = matches[0];
  return { id: feature.properties.id, name: feature.properties.name, boundarySource: feature.properties.sourceUrl };
}
