import { auditModule, sanitizeAuditDetails } from './auditLog';
export function publicAuditLog(log:any) {
  return {id:log.id, timestamp:log.timestamp,actorId:log.actorId || '',actorName:log.actorName || 'Not recorded',actorRole:log.actorRole || 'UNAUTHENTICATED',actorBarangayId:log.actorBarangayId || null,
    action:log.action || '',module:log.module || auditModule(log.targetType,log.action),targetType:log.targetType || '',targetId:log.targetId || '',outcome:log.outcome || 'not_recorded',details:sanitizeAuditDetails(log.details || {})};
}
export function canViewAuditLog(user:{uid:string;role:string},log:any) {
  if(user.role==='SUPER_ADMIN')return true;
  if(user.role!=='LGU_ADMIN')return false;
  return ['Reports','Alerts','Emergency Mode','Evacuation Centers'].includes(log.module || auditModule(log.targetType,log.action)) || log.actorId===user.uid || log.actorRole==='BARANGAY_OFFICIAL' || ['RESIDENT','BARANGAY_OFFICIAL'].includes(log.details?.role);
}
export function matchesAuditFilter(log:any,query:any) {
  const milliseconds=(value:any)=>value?.toDate?value.toDate().getTime():new Date(value?.seconds ? value.seconds*1000 : value).getTime();
  const at=milliseconds(log.timestamp);
  if(query.from && at<Date.parse(query.from))return false;
  if(query.to && at>Date.parse(query.to))return false;
  if(query.module && log.module!==query.module)return false;
  if(query.action && log.action!==query.action)return false;
  if(query.role && log.actorRole!==query.role)return false;
  if(query.user && log.actorId!==query.user)return false;
  const q=String(query.q || '').toLowerCase();
  return !q || JSON.stringify(log).toLowerCase().includes(q);
}
