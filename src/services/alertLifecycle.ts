export function alertTime(value:any):number|null {
  const time=value?.toMillis?.() ?? value?.toDate?.()?.getTime() ?? (value?._seconds!==undefined?value._seconds*1000:value?.seconds!==undefined?value.seconds*1000:value instanceof Date?value.getTime():typeof value==='string'?Date.parse(value):NaN);
  return Number.isFinite(time)?time:null;
}
export function alertLifecycle(data:any,now=Date.now()):string {
  const status=String(data?.status || '').toLowerCase();
  if(['deactivated','cancelled','inactive','resolved','expired'].includes(status))return status;
  if(status==='draft')return 'draft';
  if(data?.deactivatedAt || data?.isActive===false || data?.active===false)return 'deactivated';
  if(data?.validityMode!=='manual' && data?.expiresAt!=null && (alertTime(data.expiresAt) ?? 0)<=now)return 'expired';
  if(data?.validityMode==='scheduled' && alertTime(data?.expiresAt)===null)return 'expired';
  return ['active','published','monitoring'].includes(status)?'published':status;
}
export function alertValidity(body:any,now=Date.now()) {
  if(body.validityMode==='manual')return {validityMode:'manual',expiresAt:null};
  if(body.validityMode!=='scheduled')throw new Error('Select an alert validity option.');
  // Require an explicit timezone; datetime-local values must be converted from Manila by the client.
  if(typeof body.expiresAt!=='string' || !/(Z|[+-]\d{2}:\d{2})$/.test(body.expiresAt))throw new Error('Enter an expiration date and time in Asia/Manila.');
  const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(body.expiresAt);
  if(!parts)throw new Error('Enter a valid expiration date and time.');
  const day=new Date(Date.UTC(Number(parts[1]),Number(parts[2])-1,Number(parts[3])));
  if(day.getUTCFullYear()!==Number(parts[1]) || day.getUTCMonth()!==Number(parts[2])-1 || day.getUTCDate()!==Number(parts[3]) || Number(parts[4])>23 || Number(parts[5])>59 || Number(parts[6] || 0)>59)throw new Error('Enter a valid expiration date and time.');
  const expires=alertTime(body.expiresAt);
  if(expires===null || expires<=now)throw new Error('Expiration must be in the future.');
  return {validityMode:'scheduled',expiresAt:new Date(expires)};
}
export function alertPriority(data:any) {const value=String(data.priority || data.severityLevel || data.severity || '').toLowerCase();return ({critical:0,high:1,warning:1,normal:2,information:2,low:3} as Record<string,number>)[value] ?? 4;}
