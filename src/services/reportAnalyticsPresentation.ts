import type { summarizeReportAnalytics } from './reportAnalytics';

type Analytics = ReturnType<typeof summarizeReportAnalytics>;
type TimingRow = [string, string, number, string];
const count = (value: number) => value.toLocaleString('en-PH');
const percent = (value: number, total: number) => total > 0 ? Math.min(100, Math.max(0, value / total * 100)) : 0;
const hourLabel = (hour: number) => `${hour % 12 || 12}:00 ${hour < 12 ? 'AM' : 'PM'}`;

export function durationLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Not recorded';
  if (value > 0 && value < 1) return '<1m';
  const minutes = Math.round(value);
  return [Math.floor(minutes / 1440) ? `${Math.floor(minutes / 1440)}d` : '',
    Math.floor(minutes % 1440 / 60) ? `${Math.floor(minutes % 1440 / 60)}h` : '',
    minutes % 60 || !minutes ? `${minutes % 60}m` : ''].filter(Boolean).join(' ');
}

const point = (value: number) => Math.round(value * 100) / 100;
function line(values: number[], left: number, right: number, top: number, bottom: number, maximum: number): string {
  return values.map((value, index) => `${index ? 'L' : 'M'}${point(left + index * (right - left) / Math.max(1, values.length - 1))} ${point(bottom - value / maximum * (bottom - top))}`).join(' ');
}

/** Keeps the original dashboard contract: the browser only binds these values to its existing layout. */
export function presentReportAnalytics(data: Analytics, scopeLabel: string) {
  const peak = data.peakHours.overall;
  const peakText = (item: typeof peak) => item ? `${hourLabel(item.hour)} (${count(item.count)})` : 'Not recorded';
  const quiet = data.hourly.reduce((best, bin) => bin.count < best.count ? bin : best, data.hourly[0]);
  const totalNote = data.period.month
    ? data.comparison.changePercent === null ? 'No reports in previous month' : `${data.comparison.changePercent > 0 ? '+' : ''}${data.comparison.changePercent}% vs previous month`
    : 'All saved report submissions';
  const verificationMaximum = Math.max(1, ...data.verification.bySeverity.map(row => row.averageMinutes ?? 0));
  const resolutionMaximum = Math.max(1, ...data.resolution.byType.map(row => row.averageMinutes ?? 0));
  const verificationLabels = ['Critical', 'High', 'Medium', 'Low', ...data.verification.bySeverity.map(row => row.label).filter(label => !['Critical', 'High', 'Medium', 'Low'].includes(label))];
  const verification: TimingRow[] = verificationLabels.map(label => {
    const row = data.verification.bySeverity.find(item => item.label === label);
    return [label, durationLabel(row?.averageMinutes ?? null), percent(row?.averageMinutes ?? 0, verificationMaximum),
      ({ Critical: 'critical', High: 'high', Medium: 'medium', Low: 'low' } as Record<string, string>)[label] || 'low'];
  });
  const resolution: TimingRow[] = [
    ['Flood Report', 'Flood report', 'flood'], ['Road Condition', 'Road condition', 'road'],
    ['Evacuation', '', 'evac'], ['Alert History', '', 'history'],
    ...(data.resolution.byType.some(item => item.label === 'Other report') ? [['Other Report', 'Other report', 'history']] : []),
  ].map(([label, source, color]) => {
    const row = data.resolution.byType.find(item => item.label === source);
    return [label, durationLabel(row?.averageMinutes ?? null), percent(row?.averageMinutes ?? 0, resolutionMaximum), color];
  });
  const measuredTypes = data.resolution.byType.filter(row => row.averageMinutes !== null).sort((a, b) => a.averageMinutes! - b.averageMinutes!);
  const fastest = measuredTypes[0];
  const slowest = measuredTypes[measuredTypes.length - 1];
  const statusLegend = [
    { key: 'approved', label: 'Approved', count: data.approved, color: '#18a550' },
    { key: 'pending', label: 'Pending', count: data.byStatus.Pending, color: '#de7b00' },
    { key: 'denied', label: 'Denied', count: data.byStatus.Rejected, color: '#e52c32' },
    ...(data.byStatus.Other ? [{ key: 'other', label: 'Other / unrecorded', count: data.byStatus.Other, color: '#8996a8' }] : []),
  ].map(item => ({ ...item, percentage: data.total ? `${percent(item.count, data.total).toFixed(1)}%` : '—' }));
  let offset = 0;
  const gradient = statusLegend.map(item => {
    const start = offset; offset += percent(item.count, data.total);
    return `${item.color} ${start}% ${offset}%`;
  }).join(', ');
  const peakMaximum = Math.max(1, ...data.hourly.map(item => item.count));
  const peakLine = line(data.hourly.map(item => item.count), 30, 1180, 16, 148, peakMaximum);
  const trendMaximum = Math.max(1, ...data.monthly.map(item => item.total));
  const trendPath = (values: number[]) => line(values, 35, 745, 18, 175, trendMaximum);
  const metrics = [
    ['bars', 'TOTAL REPORTS', count(data.total), totalNote, 'blue'],
    ['stopwatch', 'AVG VERIFICATION TIME', durationLabel(data.verification.averageMinutes), `${data.verification.count} recorded review intervals`, 'purple'],
    ['clock', 'AVG RESOLUTION TIME', durationLabel(data.resolution.averageMinutes), `${data.resolution.count} recorded resolution intervals`, 'teal'],
    ['trend', 'PEAK REPORTING HOUR', peak ? hourLabel(peak.hour) : 'Not recorded', peak ? `${peak.count} reports at peak (Manila)` : 'No dated submissions', 'orange'],
    ['check', 'APPROVAL RATE', data.approvalRate === null ? 'Not recorded' : `${data.approvalRate}%`, `${data.approved} of ${data.total} verified or resolved`, 'green'],
  ];

  return {
    version: 1,
    periodLabel: data.period.label, scopeLabel,
    retrievedLabel: new Date(data.updatedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }),
    metrics,
    barangays: data.barangays.map(item => [item.name, item.count]),
    roads: data.roads.map(item => [item.name, item.barangay, item.count]),
    barangayMaximum: data.barangays[0]?.count || 1, roadMaximum: data.roads[0]?.count || 1,
    barangayTotal: `Total: ${count(data.total)} reports across ${data.barangays.length} saved barangay groups`,
    barangayLeader: data.barangays[0] ? `${data.barangays[0].name} leads at ${count(data.barangays[0].count)}` : 'No reports recorded',
    roadNote: data.roads[0] ? `${data.roads[0].name} has ${count(data.roads[0].count)} road-report submissions in this period. Rankings count submissions, not unique incidents.` : 'No named road reports in this period.',
    peaks: { morning: peakText(data.peakHours.morning), afternoon: peakText(data.peakHours.afternoon), quiet: data.coverage.datedReports ? `${hourLabel(quiet.hour)} (${count(quiet.count)})` : 'Not recorded' },
    peakCaption: `${count(data.coverage.datedReports)} dated submissions, grouped by hour in Manila time. Ties select the earliest hour.${data.coverage.undatedReports ? ` ${count(data.coverage.undatedReports)} undated reports are included only in all-time totals.` : ''}`,
    verification, resolution,
    verificationTotal: durationLabel(data.verification.averageMinutes), resolutionTotal: durationLabel(data.resolution.averageMinutes),
    verificationNote: `${data.verification.count} of ${data.verification.eligibleCount} eligible reports measured`,
    resolutionNote: `${data.resolution.count} of ${data.resolution.eligibleCount} resolved reports measured`,
    verificationCaption: 'Measured from recorded submission to verification or rejection. Pending reports and missing, negative or future intervals are excluded.',
    resolutionCaption: 'Measured from recorded review to resolution. Evacuation and alert response times are not recorded in this report dataset.',
    fastest: { label: fastest?.label || 'Not recorded', value: durationLabel(fastest?.averageMinutes ?? null) },
    slowest: { label: slowest?.label || 'Not recorded', value: durationLabel(slowest?.averageMinutes ?? null) },
    statusLegend, statusGradient: data.total ? `conic-gradient(${gradient})` : '#e8edf4',
    statusDescription: statusLegend.map(item => `${item.count} ${item.label}`).join(', '),
    statusCaption: `${count(data.total)} reports — ${data.period.label}. Approved includes Verified and Resolved.`,
    trendCaption: `${data.monthly[0]?.label || ''} – ${data.monthly[data.monthly.length - 1]?.label || ''} submissions; current status breakdown`,
    charts: {
      peak: { line: peakLine, area: `${peakLine} L1180 148H30Z`, labels: data.hourly.filter(item => item.hour % 2 === 0).map(item => ({ label: hourLabel(item.hour).replace(':00 ', ''), x: point(30 + item.hour / 23 * 1150) })), description: data.hourly.map(item => `${hourLabel(item.hour)}: ${item.count}`).join(', ') },
      trend: {
        total: trendPath(data.monthly.map(item => item.total)), approved: trendPath(data.monthly.map(item => item.Verified + item.Resolved)),
        pending: trendPath(data.monthly.map(item => item.Pending)), denied: trendPath(data.monthly.map(item => item.Rejected)),
        labels: data.monthly.map(item => new Date(`${item.month}-01T00:00:00+08:00`).toLocaleDateString('en-PH', { month: 'short', timeZone: 'Asia/Manila' })),
      },
    },
    csvRows: [
      ['LigTAS report analytics'], ['Period', data.period.label], ['Scope', scopeLabel], ['Time zone', data.period.timeZone], ['Retrieved at', data.updatedAt],
      ['Cohort', 'Submission period with current statuses. Approved includes Verified and Resolved.'], [],
      ['Metric', 'Value', 'Measured reports'], ['Total reports', data.total], ['Approved (verified + resolved)', data.approved], ['Approval rate (%)', data.approvalRate ?? 'Not recorded'],
      ['Average verification time (minutes)', data.verification.averageMinutes ?? 'Not recorded', data.verification.count],
      ['Average resolution time (minutes)', data.resolution.averageMinutes ?? 'Not recorded', data.resolution.count],
      [], ['Status', 'Reports'], ...Object.entries(data.byStatus), [], ['Report type', 'Reports'], ...Object.entries(data.byType),
      [], ['Barangay', 'Reports'], ...data.barangays.map(item => [item.name, item.count]),
      [], ['Saved road / location', 'Barangay', 'Reports'], ...data.roads.map(item => [item.name, item.barangay, item.count]),
      [], ['Hour (Manila)', 'Reports'], ...data.hourly.map(item => [hourLabel(item.hour), item.count]),
      [], ['Verification severity', 'Average minutes', 'Measured reports'], ...data.verification.bySeverity.map(item => [item.label, item.averageMinutes ?? 'Not recorded', item.count]),
      [], ['Resolution report type', 'Average minutes', 'Measured reports'], ...data.resolution.byType.map(item => [item.label, item.averageMinutes ?? 'Not recorded', item.count]),
      [], ['Submission month', 'Total', 'Verified', 'Resolved', 'Pending', 'Rejected', 'Other'],
      ...data.monthly.map(item => [item.month, item.total, item.Verified, item.Resolved, item.Pending, item.Rejected, item.Other]),
    ],
  };
}
