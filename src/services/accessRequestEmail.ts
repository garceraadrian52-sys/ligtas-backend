import nodemailer from 'nodemailer';
import { isValidEmail } from './profileFields';

export interface AccessRequestRejectionEmail {
  email: string;
  fullName: string;
  role: string;
  reason: string;
}

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

export async function sendAccessRequestRejectionEmail(request: AccessRequestRejectionEmail) {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM?.trim();
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !pass || !from) {
    const error = new Error('Rejection email delivery is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM.');
    Object.assign(error, { code: 'ACCESS_REQUEST_EMAIL_NOT_CONFIGURED' });
    throw error;
  }

  const recipient=request.email.trim().toLowerCase();
  if(!isValidEmail(recipient)){throw Object.assign(new Error('The requester email address is invalid.'),{code:'ACCESS_REQUEST_EMAIL_INVALID_RECIPIENT'});}
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  const name = request.fullName.trim() || 'Applicant';
  const role = request.role.trim() || 'requested role';
  const reason = request.reason.trim();
  const safeName = htmlEscape(name);
  const safeRole = htmlEscape(role);
  const safeReason = htmlEscape(reason).replace(/\r?\n/g, '<br>');

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
  const result = await Promise.race([transporter.sendMail({
    from,
    to: recipient,
    subject: 'LigTAS access request rejected',
    text: [
      `Hello ${name},`,
      '',
      `Your request for ${role} access to LigTAS was rejected.`,
      '',
      'Reason for rejection:',
      reason,
      '',
      'If you have questions, please contact the LGU office that reviewed your request.',
      '',
      'LigTAS',
    ].join('\n'),
    html: `<div style="font-family:Arial,sans-serif;color:#26384d;line-height:1.6;max-width:620px;margin:0 auto;padding:24px"><h2 style="color:#173d70;margin:0 0 16px">LigTAS access request update</h2><p>Hello ${safeName},</p><p>Your request for <strong>${safeRole}</strong> access to LigTAS was rejected.</p><div style="border-left:4px solid #d54a5b;background:#fff6f7;padding:14px 16px;margin:20px 0"><strong>Reason for rejection</strong><p style="margin:8px 0 0">${safeReason}</p></div><p>If you have questions, please contact the LGU office that reviewed your request.</p><p style="margin-top:24px;color:#64748b">LigTAS</p></div>`,
  }),new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>reject(Object.assign(new Error('The mail service timed out.'),{code:'ACCESS_REQUEST_EMAIL_TIMEOUT'})),12000);})]);
  // A resolved SMTP request can still reject this recipient; never report that as sent.
  const accepted=(result.accepted || []).some(address=>String(address).toLowerCase()===recipient);
  if(!accepted)throw Object.assign(new Error('The mail server did not accept the rejection email.'),{code:'ACCESS_REQUEST_EMAIL_REJECTED'});
  } finally {
    clearTimeout(timeout);
    transporter.close();
  }
}
