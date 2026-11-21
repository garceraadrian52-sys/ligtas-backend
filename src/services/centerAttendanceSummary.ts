import { recordedMillis } from './reportAnalytics';
import type { Firestore } from 'firebase-admin/firestore';
import { isMunicipalityAdmin } from './roles';
import { validDocumentId } from './inputValidation';
type Row=Record<string,any>;
const whole=(value:any):number|null=>value!==null&&value!==undefined&&value!==''&&typeof value!=='boolean'&&Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;
const active=(row:Row)=>['checked_in','active','inside'].includes(String(row.status||'').toLowerCase());
export function summarizeCenterAttendance(center:Row, records:Row[], activeHouseholds:Row[]) {
 const activeRecords=records.filter(active),members=new Set<string>();let incomplete=false;
 const rows=activeRecords.map(row=>{
   const original=Array.isArray(row.memberIds)?row.memberIds.filter((id:any)=>typeof id==='string'&&id):[];
   const ids=original.filter((id:string)=>!Object.prototype.hasOwnProperty.call(row.memberCheckouts||{},id));
   if(!ids.length||new Set(ids).size!==ids.length||whole(row.peopleCount)!==null&&whole(row.peopleCount)!==original.length)incomplete=true;
   ids.forEach((id:string)=>{const key=JSON.stringify([row.householdId||row.id,id]);if(members.has(key))incomplete=true;members.add(key);});
   return {id:row.id,householdId:row.householdId||null,household:row.householdName||'Household name not recorded',householdDisplayId:row.householdDisplayId||null,
    peopleCount:ids.length,checkedInAt:row.recordedAt||row.checkedInAt||row.createdAt||null,recordedByName:row.recordedByName||null,
    members:ids.map((id:string,index:number)=>({id,name:row.memberNames?.[original.indexOf(id)]||'Name not recorded',relationship:row.memberRelationships?.[original.indexOf(id)]||null}))};
 });
 const activeMembers=new Set<string>();let activeIncomplete=false;
 activeHouseholds.filter(row=>row.status!=='checked_out').forEach(row=>{
   if(!Array.isArray(row.memberIds)){activeIncomplete=true;return;}
   row.memberIds.forEach((id:any)=>{if(typeof id==='string'&&id)activeMembers.add(JSON.stringify([row.householdId||row.id,id]));else activeIncomplete=true;});
 });
 const occupied=whole(center.occupied??center.currentOccupancy??center.occupancyCount);
 const aliasMismatch=['occupied','currentOccupancy','occupancyCount'].some(key=>center[key]!=null&&whole(center[key])!==occupied);
 const unclassified=records.some(row=>!active(row)&&!['checked_out','cancelled','canceled'].includes(String(row.status||'').toLowerCase()));
 const sameMembership=members.size===activeMembers.size&&[...members].every(id=>activeMembers.has(id));
 const state=occupied===null||incomplete||activeIncomplete||unclassified?'unknown':aliasMismatch?'review_required':occupied>0&&members.size===0&&activeMembers.size===0?'legacy_or_unlinked':occupied!==members.size||!sameMembership?'review_required':'matched';
 rows.sort((a,b)=>(recordedMillis(b.checkedInAt)??-Infinity)-(recordedMillis(a.checkedInAt)??-Infinity));
 return {records:rows,center,activeOccupancy:!incomplete&&!activeIncomplete&&!unclassified&&sameMembership&&(members.size>0||occupied===0)?members.size:null,reconciliation:{state,savedOccupancy:occupied,recordedMembers:members.size,activeMembers:activeMembers.size,recordCount:rows.length,aliasMismatch,incomplete:incomplete||activeIncomplete||unclassified},checkedAt:new Date()};
}
export async function loadCenterAttendanceSummary(db:Firestore,actor:{role:string;barangayId:string|null},id:string) {
 if(!validDocumentId(id))throw Object.assign(new Error('Invalid center ID.'),{status:400});
 return db.runTransaction(async tx=>{
  const center=await tx.get(db.doc('evacuationCenters/'+id));
  if(!center.exists)throw Object.assign(new Error('Evacuation center not found.'),{status:404});
  const data=center.data()!;
  if(!isMunicipalityAdmin(actor.role)&&(actor.role!=='BARANGAY_OFFICIAL'||!actor.barangayId||actor.barangayId!==data.barangayId))throw Object.assign(new Error('This center is outside your assigned barangay.'),{status:403});
  const [records,active]=await Promise.all([tx.get(db.collection('evacuationRecords').where('evacuationCenterId','==',id)),tx.get(db.collection('activeEvacuations').where('evacuationCenterId','==',id))]);
  const summary=summarizeCenterAttendance({...data,id:center.id},records.docs.map(doc=>({...doc.data(),id:doc.id})),active.docs.map(doc=>({id:doc.id,...doc.data()})));
  const ids=[...new Set(summary.records.map(row=>row.householdId).filter(validDocumentId))];
  const households=await Promise.all(ids.map(householdId=>tx.get(db.doc('households/'+householdId))));
  const labels=new Map(households.filter(doc=>doc.exists).map(doc=>[doc.id,doc.data()?.displayId]));
  summary.records.forEach(row=>{const label=labels.get(row.householdId);if(typeof label==='string'&&/^HH-\d+$/i.test(label))row.householdDisplayId=label;});
  return summary;
 });
}
