import nodemailer from 'nodemailer';

export interface SendEmailParams {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  attachment?: { filename: string; content: Buffer };
}

export interface SendEmailResult {
  ok: boolean;
  provider: string;
  messageId?: string;
  error?: string;
}

/**
 * Real SMTP abstraction. If SMTP_HOST/USER/PASSWORD are not set in the
 * environment, this returns ok:false with a clear "not configured" error
 * rather than pretending the email was sent. Swap in SendGrid/SES/Resend
 * by changing this file's transport only — callers are unaffected.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const isGmail = /gmail|googlemail/i.test(host || '');
  // Google shows App Passwords as "abcd efgh ijkl mnop" - the spaces are not part of the password
  const pass = isGmail ? process.env.SMTP_PASSWORD?.replace(/\s+/g, '') : process.env.SMTP_PASSWORD?.trim();
  // Gmail only sends as the authenticated account, so default the From address to it
  const from = (isGmail && (!process.env.EMAIL_FROM || /example\.com|hawmess\.com|mopuribusiness\.com/i.test(process.env.EMAIL_FROM)))
    ? `Barid-IN <${user}>` : (process.env.EMAIL_FROM || 'no-reply@example.com');

  if (!host || !user || !pass) {
    return {
      ok: false,
      provider: 'smtp',
      error:
        'Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD in the backend .env file to enable sending.',
    };
  }

  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user, pass },
  });

  try {
    const info = await transporter.sendMail({
      from,
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject,
      text: params.text,
      attachments: params.attachment
        ? [{ filename: params.attachment.filename, content: params.attachment.content }]
        : [],
    });
    return { ok: true, provider: 'smtp', messageId: info.messageId };
  } catch (e: any) {
    const msg: string = e?.message || 'SMTP send failed';
    if (e?.responseCode === 535 || /BadCredentials|Invalid login|Username and Password not accepted/i.test(msg)) {
      return { ok: false, provider: 'smtp', error: isGmail
        ? 'Gmail rejected the login. Gmail does not accept your normal password here: turn on 2-Step Verification, create an App Password (https://myaccount.google.com/apppasswords) and put it in SMTP_PASSWORD, with SMTP_USER set to the same Gmail address. Then restart the backend.'
        : 'The mail server rejected the SMTP username/password. Check SMTP_USER and SMTP_PASSWORD in the backend .env file and restart the backend.' };
    }
    return { ok: false, provider: 'smtp', error: msg };
  }
}
