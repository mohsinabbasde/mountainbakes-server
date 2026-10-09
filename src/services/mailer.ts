import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Outgoing email, over SMTP.
 *
 * One kind of message is sent today: the password reset link. Supabase Auth
 * used to send it; now the API does, through whichever SMTP account the
 * environment names.
 *
 *   SMTP_HOST   e.g. smtp.gmail.com
 *   SMTP_PORT   587 (STARTTLS, the default) or 465 (TLS from the first byte)
 *   SMTP_USER   the account to sign in as
 *   SMTP_PASS   its password / app password
 *   SMTP_FROM   the From header, e.g. "Mountain Bakes <no-reply@example.com>"
 *               (defaults to SMTP_USER)
 */

export class MailNotConfiguredError extends Error {
  status = 503;
  details = { code: 'mail_not_configured' };

  constructor() {
    super('Email is not set up on this server, so the link could not be sent. Ask an administrator to set a temporary password instead.');
    this.name = 'MailNotConfiguredError';
  }
}

let transporter: Transporter | null = null;

export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function transport(): Transporter {
  if (!mailConfigured()) throw new MailNotConfiguredError();
  const port = Number(process.env.SMTP_PORT) || 587;
  transporter ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

/** Tests swap in a transport that records instead of sending. */
export function setMailTransport(next: Transporter | null): void {
  transporter = next;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The web app's address, for links in email. The first of the configured
 * browser origins — the same setting CORS is built from.
 */
export function webUrl(): string {
  const first = (process.env.NEXT_PUBLIC_WEB_URL || process.env.CORS_ORIGINS || 'http://localhost:3000').split(',')[0]!.trim();
  return first.replace(/\/+$/, '');
}

export async function sendPasswordResetEmail(to: string, token: string, minutesValid: number): Promise<void> {
  const link = `${webUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const text = [
    'A password reset was requested for your Mountain Bakes account.',
    '',
    `Open this link to choose a new password. It works once, for the next ${minutesValid} minutes:`,
    link,
    '',
    'If you did not ask for this, ignore this email — your password has not been changed.',
  ].join('\n');
  const html =
    `<p>A password reset was requested for your Mountain Bakes account.</p>` +
    `<p><a href="${escapeHtml(link)}">Choose a new password</a></p>` +
    `<p>The link works once, for the next ${minutesValid} minutes.</p>` +
    `<p>If you did not ask for this, ignore this email — your password has not been changed.</p>`;

  await transport().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'Reset your Mountain Bakes password',
    text,
    html,
  });
}
