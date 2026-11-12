import type { RequestHandler } from 'express';
import type { AuthenticatedRequest } from './auth';
import { auditActor, logAction } from '../services/auditLog';
export function operationForRequest(method: string, path: string, body:any = {}) {
  if (!['POST','PATCH','DELETE'].includes(method)) return null;
  if (/^\/auth\/(?:mobile-)?login$/.test(path)) return {action:'login_failed',targetType:'user',module:'Authentication',targetId:''};
  if (path === '/auth/forgot-password') return {action:'password_reset_requested',targetType:'user',module:'Authentication',targetId:''};
  if (/^\/profile\/password$/.test(path)) return {action:'password_changed',targetType:'user',module:'Authentication',targetId:''};
  const match=path.match(/^\/(users|reports|alerts|evacuation-centers|profile|settings|emergency-mode|exports)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!match || ['login','activity','account-id'].includes(match[2])) return null;
  const [,group,id,suffix]=match;
  const targetType=({users:'user',reports:'report',alerts:'alert','evacuation-centers':'evacuationCenter',profile:'user',settings:'settings','emergency-mode':'emergencyMode',exports:'system'} as Record<string,string>)[group];
  const action=group==='reports' ? (method==='POST' ? 'report_submitted' : 'report_'+String(body.status || 'updated').toLowerCase()) : group==='alerts' ? (suffix==='publish' ? 'alert_published' : method==='POST' ? 'alert_created' : 'alert_updated') : group==='emergency-mode' ? (body.active ? 'emergency_mode_activated':'emergency_mode_deactivated') : group==='exports' ? 'data_exported' : group==='settings' ? (id==='backup'?'partial_backup_exported':'settings_updated') : group==='profile' ? 'profile_updated' : group==='users' ? (suffix==='status'?'user_deactivated':method==='POST'?'user_created':'user_updated') : method==='POST'?'evacuation_center_created':'evacuation_center_updated';
  return {action,targetType,targetId:id || ''};
}
export const auditFailures: RequestHandler = (req:AuthenticatedRequest,res,next) => {
  res.once('finish',()=>{
    if (res.statusCode<400) return;
    const operation=operationForRequest(req.method,req.path,req.body);
    if (!operation) return;
    void logAction({...operation,...(req.user?auditActor(req.user):{actorId:'',actorName:'Not recorded',actorRole:'UNAUTHENTICATED'}),outcome:'failure',details:{httpStatus:res.statusCode,reasonCode:res.statusCode>=500?'SERVICE_UNAVAILABLE':res.statusCode===403?'PERMISSION_DENIED':'REQUEST_REJECTED'}});
  });next();
};
