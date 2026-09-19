import { describe, expect, it, vi } from 'vitest';
import { BrevoEmailSender } from '../src/email';

const from = { email: 'sender@example.test', name: 'Office Hours' };
const mail = { to: 'someone@example.test', subject: 'Hello', text: 'Body' };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

describe('Brevo email sender', () => {
  it('posts to the transactional API with the key in a header, never in the body or URL', async () => {
    const f = fakeFetch(201, { messageId: 'x' });
    await new BrevoEmailSender('xkeysib-secret', from, f as never).send(mail);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-secret');
    expect(url).not.toContain('xkeysib');
    expect(String(init.body)).not.toContain('xkeysib');
    expect(JSON.parse(String(init.body))).toEqual({ sender: from, to: [{ email: 'someone@example.test' }], subject: 'Hello', textContent: 'Body' });
  });

  it('reports why Brevo refused, so the cause shows up in the server logs', async () => {
    await expect(new BrevoEmailSender('k', from, fakeFetch(400, { code: 'invalid_parameter', message: 'Sender is not valid' }) as never).send(mail)).rejects.toThrow(
      'Email provider refused the message (400): Sender is not valid',
    );
    await expect(new BrevoEmailSender('k', from, fakeFetch(401, { message: 'Key not found' }) as never).send(mail)).rejects.toThrow(/\(401\): Key not found/);
  });

  it('still fails clearly when the refusal has no readable body, and never echoes the key', async () => {
    const err = await new BrevoEmailSender('xkeysib-secret', from, fakeFetch(502, 'Bad Gateway') as never).send(mail).catch((e: Error) => e);
    expect((err as Error).message).toBe('Email provider refused the message (502)');
    expect((err as Error).message).not.toContain('xkeysib');
  });
});
