type Report = Record<string, any>;
type Barangay = { id: string; name?: string };
type TimingGroup = { label: string; count: number; averageMinutes: number | null };

const TIME_ZONE = 'Asia/Manila';
const OFFSET_MS = 8 * 60 * 60 * 1000;
const statusNames = ['Pending', 'Verified', 'Rejected', 'Resolved', 'Other'] as const;
type Status = typeof statusNames[number];

// Do not substitute updatedAt: editing a report is not a submission or review.
export function recordedMillis(value: unknown): number | null {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  let millis: number;
  try {
    const timestamp = value as any;
    if (typeof timestamp.toMillis === 'function') millis = timestamp.toMillis();
    else if (timestamp.seconds !== undefined || timestamp._seconds !== undefined) {
      const seconds = timestamp.seconds ?? timestamp._seconds;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
      millis = seconds * 1000;
    } else if (value instanceof Date) millis = value.getTime();
    else if (typeof value === 'string') millis = Date.parse(value);
    else if (typeof value === 'number') millis = value;
    else return null;
  } catch { return null; }
  return Number.isFinite(millis) && millis >= 0 && millis <= 8640000000000000 ? millis : null;
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const round = (value: number) => Math.round(value * 10) / 10;
const monthKey = (millis: number) => new Date(millis + OFFSET_MS).toISOString().slice(0, 7);
const monthDate = (month: string, offset = 0) => {
  const [year, number] = month.split('-').map(Number);
  return Date.UTC(year, number - 1 + offset, 1) - OFFSET_MS;
};
const monthLabel = (month: string) => new Intl.DateTimeFormat('en-PH', {
  month: 'long', year: 'numeric', timeZone: TIME_ZONE,
}).format(new Date(monthDate(month)));

export function validAnalyticsMonth(value: unknown): value is string {
  return typeof value === 'string' && /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value);
}

function reportStatus(report: Report): Status {
  const normalize = (value: unknown): Status | null => {
    const raw = text(value).toLowerCase();
    if (raw === 'approved') return 'Verified';
    if (raw === 'denied') return 'Rejected';
    return statusNames.find(name => name.toLowerCase() === raw) ?? null;
  };
  // A terminal/current status takes precedence over an old verification flag.
  return normalize(report.status) ?? normalize(report.verification) ?? 'Other';
}

function reportType(report: Report): 'flood' | 'road' | 'other' {
  const raw = text(report.type || report.reportType).toLowerCase();
  if (raw.includes('road')) return 'road';
  if (raw.includes('flood')) return 'flood';
  return 'other';
}

function severity(report: Report): string {
  const raw = text(report.priority || report.severityLevel || report.severity).toLowerCase();
  return ['Critical', 'High', 'Medium', 'Low', 'Normal'].find(label => label.toLowerCase() === raw)
    ?? (raw ? 'Other' : 'Not recorded');
}

function mean(values: number[]): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function duration(start: number | null, end: number | null, now: number): number | null {
  return start !== null && end !== null && end >= start && end <= now ? (end - start) / 60000 : null;
}

function timingGroups(rows: { report: Report; minutes: number | null }[], labelFor: (report: Report) => string, order: string[]): TimingGroup[] {
  return order.flatMap(label => {
    const group = rows.filter(row => labelFor(row.report) === label);
    if (!group.length) return [];
    const values = group.flatMap(row => row.minutes === null ? [] : [row.minutes]);
    return [{ label, count: values.length, averageMinutes: mean(values) }];
  });
}

/** Aggregates the authorized reports collection only; roadConditions mirrors are not counted. */
export function summarizeReportAnalytics(reports: Report[], options: {
  month?: string; now?: number; barangays?: Barangay[];
} = {}) {
  const now = options.now ?? Date.now();
  const month = options.month ?? null;
  if (month !== null && !validAnalyticsMonth(month)) throw new Error('Invalid analytics month.');
  const start = month ? monthDate(month) : null;
  const end = month ? monthDate(month, 1) : null;
  const names = new Map((options.barangays ?? []).map(item => [item.id, text(item.name) || item.id]));
  const rows = reports.map(report => ({ report, submitted: recordedMillis(report.createdAt) ?? recordedMillis(report.submittedAt), status: reportStatus(report), type: reportType(report) }));
  const selected = rows.filter(row => !month || (row.submitted !== null && row.submitted >= start! && row.submitted < end!));
  const byStatus: Record<Status, number> = { Pending: 0, Verified: 0, Rejected: 0, Resolved: 0, Other: 0 };
  const byType = { flood: 0, road: 0, other: 0 };
  const byBarangay: Record<string, number> = Object.create(null);
  const barangayGroups = new Map<string, { id: string; name: string; count: number }>();
  const roadGroups = new Map<string, { id: string; name: string; barangay: string; count: number }>();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const verificationRows: { report: Report; minutes: number | null }[] = [];
  const resolutionRows: { report: Report; minutes: number | null }[] = [];
  let unnamedRoadReports = 0;

  for (const { report, submitted, status, type } of selected) {
    byStatus[status]++;
    byType[type]++;
    const barangayId = text(report.barangayId) || text(report.barangay) || 'unassigned';
    const barangayName = names.get(barangayId) || text(report.barangayName) || text(report.barangay) || (barangayId === 'unassigned' ? 'Not assigned' : barangayId);
    byBarangay[barangayId] = (byBarangay[barangayId] ?? 0) + 1;
    const group = barangayGroups.get(barangayId) ?? { id: barangayId, name: barangayName, count: 0 };
    group.count++;
    barangayGroups.set(barangayId, group);
    if (submitted !== null) hourly[new Date(submitted + OFFSET_MS).getUTCHours()].count++;
    if (type === 'road') {
      const name = text(report.roadName) || text(report.location);
      if (!name) unnamedRoadReports++;
      else {
        const id = JSON.stringify([barangayId, text(report.matchedRoadId) || name.toLowerCase()]);
        const road = roadGroups.get(id) ?? { id, name, barangay: barangayName, count: 0 };
        road.count++;
        roadGroups.set(id, road);
      }
    }

    const verified = recordedMillis(report.verifiedAt);
    const reviewed = recordedMillis(report.reviewedAt);
    const resolved = recordedMillis(report.resolvedAt);
    // Older clients overwrite reviewedAt when resolving. Never treat that write as verification.
    const resolutionReview = verified ?? (reviewed !== null && resolved !== null && reviewed < resolved ? reviewed : null);
    const reviewTime = status === 'Resolved' ? resolutionReview
      : status === 'Verified' ? verified ?? reviewed
      : status === 'Rejected' ? reviewed : null;
    if (['Verified', 'Rejected', 'Resolved'].includes(status)) {
      verificationRows.push({ report, minutes: duration(submitted, reviewTime, now) });
    }
    if (status === 'Resolved') {
      // A legacy reviewedAt may equal the resolution write; require a distinct earlier review.
      resolutionRows.push({ report, minutes: duration(resolutionReview, resolved, now) });
    }
  }

  const sortRanking = <T extends { count: number; name: string }>(items: T[]) => items.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const verificationValues = verificationRows.flatMap(row => row.minutes === null ? [] : [row.minutes]);
  const resolutionValues = resolutionRows.flatMap(row => row.minutes === null ? [] : [row.minutes]);
  const anchorMonth = month ?? monthKey(now);
  const trendMonths = Array.from({ length: 6 }, (_, index) => monthKey(monthDate(anchorMonth, index - 5)));
  const monthly = trendMonths.map(key => {
    const monthRows = rows.filter(row => row.submitted !== null && monthKey(row.submitted) === key);
    const counts = { Pending: 0, Verified: 0, Rejected: 0, Resolved: 0, Other: 0 };
    monthRows.forEach(row => counts[row.status]++);
    return { month: key, label: monthLabel(key), total: monthRows.length, ...counts };
  });
  const approved = byStatus.Verified + byStatus.Resolved;
  const previousMonth = month ? monthKey(monthDate(month, -1)) : null;
  const previousTotal = previousMonth ? rows.filter(row => row.submitted !== null && monthKey(row.submitted) === previousMonth).length : null;
  const peak = (bins: typeof hourly) => bins.reduce<typeof hourly[number] | null>((best, bin) => bin.count > (best?.count ?? 0) ? bin : best, null);

  return {
    analyticsVersion: 1,
    updatedAt: new Date(now).toISOString(),
    period: { month, label: month ? monthLabel(month) : 'All time', timeZone: TIME_ZONE, startAt: start === null ? null : new Date(start).toISOString(), endAt: end === null ? null : new Date(end).toISOString() },
    total: selected.length, byStatus, byType, byBarangay,
    approved, approvalRate: selected.length ? round(approved / selected.length * 100) : null,
    comparison: { previousMonth, previousTotal, changePercent: previousTotal ? round((selected.length - previousTotal) / previousTotal * 100) : null },
    barangays: sortRanking([...barangayGroups.values()]), roads: sortRanking([...roadGroups.values()]),
    hourly, peakHours: { overall: peak(hourly), morning: peak(hourly.filter(bin => bin.hour >= 6 && bin.hour < 12)), afternoon: peak(hourly.filter(bin => bin.hour >= 12 && bin.hour < 18)) },
    verification: {
      averageMinutes: mean(verificationValues), count: verificationValues.length, eligibleCount: verificationRows.length,
      bySeverity: timingGroups(verificationRows, severity, ['Critical', 'High', 'Medium', 'Low', 'Normal', 'Other', 'Not recorded']),
    },
    resolution: {
      averageMinutes: mean(resolutionValues), count: resolutionValues.length, eligibleCount: resolutionRows.length,
      byType: timingGroups(resolutionRows, report => ({ flood: 'Flood report', road: 'Road condition', other: 'Other report' })[reportType(report)], ['Flood report', 'Road condition', 'Other report']),
    },
    monthly,
    coverage: { undatedReports: rows.filter(row => row.submitted === null).length, datedReports: selected.filter(row => row.submitted !== null).length, unnamedRoadReports },
  };
}
