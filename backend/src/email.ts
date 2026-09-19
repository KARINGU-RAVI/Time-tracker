/**
 * Outgoing email. The app only depends on the EmailSender interface, so the provider can change
 * (Brevo free tier today) without touching the sign-in code. Tests use MemoryEmailSender.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(mail: OutgoingEmail): Promise<void>;
}

/** Keeps mail in memory. Tests read `sent` to find the verification and reset links. */
export class MemoryEmailSender implements EmailSender {
  sent: OutgoingEmail[] = [];
  async send(mail: OutgoingEmail): Promise<void> {
    this.sent.push(mail);
  }
  last(to?: string): OutgoingEmail | undefined {
    return [...this.sent].reverse().find((m) => !to || m.to === to);
  }
}

/** Development: prints mail to the terminal instead of sending it. */
export class ConsoleEmailSender implements EmailSender {
  async send(mail: OutgoingEmail): Promise<void> {
    console.log(`\n--- email to ${mail.to} ---\n${mail.subject}\n\n${mail.text}\n---\n`);
  }
}

/** Brevo transactional email over HTTPS (free plan: 300 a day). Needs a verified sender address. */
export class BrevoEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: { email: string; name: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(mail: OutgoingEmail): Promise<void> {
    const res = await this.fetchImpl('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: this.from,
        to: [{ email: mail.to }],
        subject: mail.subject,
        textContent: mail.text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // Brevo explains refusals in a short JSON message (for example an unverified sender). Keep it for the server logs.
      let reason = '';
      try {
        reason = String(((await res.json()) as { message?: unknown }).message ?? '').slice(0, 200);
      } catch {
        /* no readable body */
      }
      throw new Error(`Email provider refused the message (${res.status})${reason ? `: ${reason}` : ''}`);
    }
  }
}

export function verificationEmail(appOrigin: string, token: string): { subject: string; text: string } {
  return {
    subject: 'Verify your email for Office Hours',
    text: [
      'Welcome to Office Hours.',
      '',
      'Open this link to verify your email address (valid for 24 hours, works once):',
      `${appOrigin}/verify-email?token=${token}`,
      '',
      'If you did not create an account, you can ignore this email.',
    ].join('\n'),
  };
}

export function resetEmail(appOrigin: string, token: string): { subject: string; text: string } {
  return {
    subject: 'Reset your Office Hours password',
    text: [
      'Someone asked to reset the password for this account.',
      '',
      'Open this link to choose a new password (valid for 1 hour, works once):',
      `${appOrigin}/reset-password?token=${token}`,
      '',
      'If this was not you, ignore this email. Your password stays as it is.',
    ].join('\n'),
  };
}

export function alreadyRegisteredEmail(appOrigin: string): { subject: string; text: string } {
  return {
    subject: 'You already have an Office Hours account',
    text: [
      'Someone tried to create an Office Hours account with this email address, but you already have one.',
      '',
      `Sign in: ${appOrigin}`,
      `Forgot your password? Reset it: ${appOrigin}/forgot-password`,
      '',
      'If this was not you, you can ignore this email.',
    ].join('\n'),
  };
}
