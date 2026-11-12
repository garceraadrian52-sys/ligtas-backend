import { createHash } from 'node:crypto';
import { db } from '../config/firebaseAdmin';
import { invalidateFirestoreReadCache } from './firestoreReadCache';
import type { Transaction } from 'firebase-admin/firestore';
export type AuditParams = {
  actorId: string; actorName: string; actorRole: string; actorEmail?: string;
  actorBarangayId?: string | null; action: string; targetType: string; targetId: string;
  module?: string; outcome?: 'success' | 'failure'; details?: Record<string, any>; eventId?: string;
};
const safeKeys = new Set(['type','status','previousStatus','role','previousRole','disabled','previouslyDisabled','barangayId','displayId','changedFields','redactedFields','before','after','count','total','succeeded','failed','reportIds','format','collections','name','truncated','reasonCode','httpStatus','active','revision','centerId','fromCenterId','toCenterId','peopleCount','recordIds','source','delivery','published','verification','capacity','occupied','currentOccupancy','occupancyCount','facilities','expectedRevision']);
const secretKey = /password|token|secret|email|phone|contact|address|photo|memberNames|householdName|description|message|location/i;
export function sanitizeAuditDetails(value: any, depth = 0): any {
  if (depth > 5) return null;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value ?? null;
  if (typeof value === 'string') return value.slice(0,500);
  if (Array.isArray(value)) return value.slice(0,200).map(item => sanitizeAuditDetails(item,depth+1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).filter(([key]) => safeKeys.has(key) && !secretKey.test(key)).map(([key,item]) => [key,sanitizeAuditDetails(item,depth+1)]));
}
export function auditModule(target: string, action = '') {
  if (/^(login|logout|password|user_password)/.test(action)) return 'Authentication';
  return ({report:'Reports',alert:'Alerts',user:'User Management',accessRequest:'User Management',evacuationCenter:'Evacuation Centers',evacuationRecord:'Evacuation Centers',emergencyMode:'Emergency Mode',settings:'Administration',system:'Administration'} as Record<string,string>)[target] || 'Administration';
}
export function auditActor(user: {uid:string;name:string;role:string;barangayId?:string|null}) {
  return {actorId:user.uid,actorName:user.name || 'Not recorded',actorRole:user.role,actorBarangayId:user.barangayId ?? null};
}
export function auditRecord(params: AuditParams) {
  return {actorId:params.actorId || '',actorName:params.actorName || 'Not recorded',actorRole:params.actorRole || 'UNAUTHENTICATED',actorBarangayId:params.actorBarangayId ?? null,
    action:params.action,module:params.module || auditModule(params.targetType,params.action),targetType:params.targetType,targetId:params.targetId || '',
    details:sanitizeAuditDetails(params.details || {}),outcome:params.outcome || 'success',timestamp:new Date()};
}
export async function logAction(params: AuditParams) {
  try {
    const record = auditRecord(params);
    if (params.eventId) await db.collection('auditLogs').doc(createHash('sha256').update(params.eventId).digest('hex')).create(record);
    else await db.collection('auditLogs').add(record);
    invalidateFirestoreReadCache('auditLogs:');
  } catch (error:any) { if (error?.code !== 6 && error?.code !== 'already-exists') console.error('Audit write unavailable:',error?.code || 'unknown'); }
}
export function logActionInTransaction(transaction: Transaction, params: AuditParams) {
  const reference=(params.eventId ? db.collection('auditLogs').doc(createHash('sha256').update(params.eventId).digest('hex')) : db.collection('auditLogs').doc());
  transaction.create(reference,auditRecord(params));return reference;
}
