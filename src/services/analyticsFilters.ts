import { recordedMillis, reportStatus, reportType } from './reportAnalytics';
type Row=Record<string,any>;
export function filterAnalyticsReports(reports:Row[], filters:{start?:string;end?:string;barangayId?:string;reportType?:string}) {
 const start=filters.start?Date.parse(filters.start+'T00:00:00+08:00'):null;
 const end=filters.end?Date.parse(filters.end+'T00:00:00+08:00')+86400000:null;
 return reports.filter(row=>{const time=recordedMillis(row.createdAt)??recordedMillis(row.submittedAt);return (!filters.barangayId||row.barangayId===filters.barangayId)&&(!filters.reportType||filters.reportType==='all'||reportType(row)===filters.reportType)&&(start===null||(time!==null&&time>=start))&&(end===null||(time!==null&&time<end));});
}
export function incidentAnalytics(reports:Row[]) {
 const confirmed=reports.filter(row=>['Verified','Resolved'].includes(reportStatus(row))&&![row.status,row.verification,row.reportStatus].some(value=>['rejected','invalid','denied','pending'].includes(String(value||'').toLowerCase())));
 const groups=new Set(confirmed.map(row=>row.incidentId).filter(Boolean));
 const standalone=confirmed.filter(row=>!row.incidentId).length;
 return {confirmedIncidents:standalone+groups.size,groupedIncidents:groups.size,supportingReports:confirmed.filter(row=>row.incidentId).length,individualReports:reports.length};
}
export function analyticsTrend(reports:Row[],start?:string,end?:string) {
 const dates=reports.flatMap(row=>{const value=recordedMillis(row.createdAt)??recordedMillis(row.submittedAt);return value===null?[]:[new Date(value+8*3600000).toISOString().slice(0,10)];}).sort();
 const first=start||dates[0],last=end||dates.at(-1);if(!first||!last)return [];
 const daily=Boolean(start&&end&&(Date.parse(end)-Date.parse(start))/86400000<=62);
 const counts=new Map<string,any>();
 for(let date=new Date(first+'T00:00:00Z');date<=new Date(last+'T23:59:59Z');daily?date.setUTCDate(date.getUTCDate()+1):date.setUTCMonth(date.getUTCMonth()+1,1)) {
  const key=date.toISOString().slice(0,daily?10:7);counts.set(key,{date:key,label:daily?key:key,total:0,Verified:0,Resolved:0,Pending:0,Rejected:0,Other:0});
 }
 for(const row of reports){const time=recordedMillis(row.createdAt)??recordedMillis(row.submittedAt);if(time===null)continue;const key=new Date(time+8*3600000).toISOString().slice(0,daily?10:7);const bin=counts.get(key);if(bin){bin.total++;bin[reportStatus(row)]++;}}
 return [...counts.values()];
}
