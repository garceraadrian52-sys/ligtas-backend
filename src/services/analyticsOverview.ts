import { summarizeReportAnalytics, reportStatus, reportType } from './reportAnalytics';
import { presentReportAnalytics } from './reportAnalyticsPresentation';
type Row = Record<string, any>;
type Barangay = { id: string; name?: string };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const whole = (value: unknown): number | null => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export function evacuationAnalytics(centers: Row[] | null, active: Row[] | null, barangays: Barangay[]) {
  const names = new Map(barangays.map(item => [item.id, text(item.name) || 'Barangay name not recorded']));
  const groups = new Map<string, { id:string; name:string; count:number }>();
  const seen = new Set<string>();
  let incompleteRecords = 0;
  for (const row of active || []) {
    if (row.status === 'checked_out') continue;
    if (!Array.isArray(row.memberIds)) { incompleteRecords++; continue; }
    const household = text(row.householdId) || text(row.id);
    const members = row.memberIds.filter((value: unknown) => typeof value === 'string' && value.trim());
    if (!household || members.length !== row.memberIds.length) { incompleteRecords++; if (!household) continue; }
    const barangayId = text(row.barangayId) || 'unassigned';
    const name = names.get(barangayId) || text(row.barangayName) || 'Barangay not recorded';
    for (const member of members) {
      const key = JSON.stringify([household, member]);
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(barangayId) || { id:barangayId, name, count:0 };
      group.count++; groups.set(barangayId, group);
    }
  }
  const byBarangay = [...groups.values()].sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
  const utilization = (centers || []).map(row => {
    const occupied = whole(row.currentOccupancy ?? row.occupied ?? row.occupancyCount);
    const rawCapacity = whole(row.capacity ?? row.maxCapacity);
    const capacity = rawCapacity && rawCapacity > 0 ? rawCapacity : null;
    return { id:text(row.id), name:text(row.name || row.centerName) || 'Evacuation center', occupied, capacity,
      percentage: occupied !== null && capacity !== null ? Math.round(occupied / capacity * 1000) / 10 : null };
  }).sort((a,b) => (b.percentage ?? -1) - (a.percentage ?? -1) || a.name.localeCompare(b.name));
  return { activeAvailable:active !== null, centersAvailable:centers !== null,
    totalEvacuees:active === null || incompleteRecords > 0 ? null : seen.size,
    recordedMembers:seen.size, incompleteRecords, byBarangay, utilization,
    barangayMaximum:Math.max(1,...byBarangay.map(item=>item.count)),
    utilizationMaximum:Math.max(100,...utilization.map(item=>item.percentage ?? 0)),
    sourceNote:'Current active household members, grouped by the household barangay. Center occupancy is reported separately; the two sources may require reconciliation.' };
}
export function buildAnalyticsOverview(reports: Row[], centers: Row[] | null, active: Row[] | null, barangays: Barangay[], scopeLabel: string, options: { month?:string; now?:number } = {}) {
  const floods = reports.filter(row => reportType(row) === 'flood');
  const summary = summarizeReportAnalytics(floods, { ...options, barangays });
  const view = presentReportAnalytics(summary, scopeLabel);
  const roads = summarizeReportAnalytics(reports.filter(row=>reportType(row)==='road'), { ...options, barangays });
  const roadView = presentReportAnalytics(roads, scopeLabel);
  const confirmed = summarizeReportAnalytics(floods.filter(row=>['Verified','Resolved'].includes(reportStatus(row))), { ...options, barangays });
  const affected = confirmed.barangays.filter(row=>row.id!=='unassigned').length;
  const evacuation = evacuationAnalytics(centers, active, barangays);
  const count = (value:number) => value.toLocaleString('en-PH');
  const statusColors: Record<string,string> = { Verified:'#18a550', Resolved:'#2563eb', Pending:'#de7b00', Rejected:'#e52c32', Other:'#8996a8' };
  const statusLegend = Object.entries(summary.byStatus).map(([label,value])=>({key:label.toLowerCase(),label:label==='Other'?'Other / unrecorded':label,count:value,color:statusColors[label],percentage:summary.total ? (value/summary.total*100).toFixed(1)+'%' : '\u2014'}));
  let offset = 0;
  const gradient = statusLegend.map(item=>{const start=offset;offset+=summary.total?item.count/summary.total*100:0;return item.color+' '+start+'% '+offset+'%';}).join(', ');
  const metrics = [
    ['bars','Total Flood Reports',count(summary.total),'Recorded flood submissions','blue'],
    ['check','Verified Reports',count(summary.byStatus.Verified),'Current Verified status','green'],
    ['pin','Affected Barangays',count(affected),'Barangays with verified or resolved flood reports','orange'],
    ['people','Total Evacuees',evacuation.totalEvacuees===null?'Not available':count(evacuation.totalEvacuees),active===null?'Current check-ins unavailable':evacuation.incompleteRecords?'Incomplete active member lists':'Currently checked-in household members','teal'],
  ];
  const csvRows: (string|number)[][] = [
    ['LigTAS flood and evacuation analytics'],['Scope',scopeLabel],['Report period',summary.period.label],['Retrieved at',summary.updatedAt],['Time zone','Asia/Manila'],[],
    ['Metric','Value'],['Total Flood Reports',summary.total],['Verified Reports',summary.byStatus.Verified],['Affected Barangays',affected],['Total Evacuees',evacuation.totalEvacuees ?? 'Not available'],[],
    ['Flood report status','Reports'],...Object.entries(summary.byStatus),[],['Flood-report barangay','Submissions'],...summary.barangays.map(row=>[row.name,row.count]),[],
    ['Saved road / location','Barangay','Submissions'],...roads.roads.map(row=>[row.name,row.barangay,row.count]),[],
    ['Submission month','Total','Verified','Resolved','Pending','Rejected','Other'],...summary.monthly.map(row=>[row.month,row.total,row.Verified,row.Resolved,row.Pending,row.Rejected,row.Other]),[],
    ['Current evacuees by household barangay',active===null?'Unavailable':'Recorded member lists'],...evacuation.byBarangay.map(row=>[row.name,row.count]),[],
    ['Current center utilization','Occupants','Capacity','Percent'],...evacuation.utilization.map(row=>[row.name,row.occupied ?? 'Not recorded',row.capacity ?? 'Not recorded',row.percentage ?? 'Not recorded']),[],
    ['Average verification time (minutes)',summary.verification.averageMinutes ?? 'Not recorded','Measured reports',summary.verification.count],
    ['Verification severity','Average minutes','Measured reports'],...summary.verification.bySeverity.map(row=>[row.label,row.averageMinutes ?? 'Not recorded',row.count]),
  ];
  return { ...view, metrics, total:summary.total, affectedBarangays:affected, roads:roadView.roads, roadMaximum:roadView.roadMaximum, roadNote:roadView.roadNote,
    statusLegend,statusGradient:summary.total?'conic-gradient('+gradient+')':'#e8edf4',statusDescription:statusLegend.map(item=>item.count+' '+item.label).join(', '),statusCaption:count(summary.total)+' flood reports; current saved review status.',evacuation,csvRows };
}
