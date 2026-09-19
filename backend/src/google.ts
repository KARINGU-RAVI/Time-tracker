import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
  /** Google's stable account id. */
  sub: string;
  email: string;
  emailVerified: boolean;
}

/** Verifies a Google ID token and returns the identity it proves. Throws when invalid. */
export type GoogleVerifier = (credential: string) => Promise<GoogleIdentity>;

/**
 * Production verifier: checks the token's signature against Google's public keys and that it
 * was issued for OUR client id (the audience), so a token minted for another app is refused.
 */
export function createGoogleVerifier(clientId: string): GoogleVerifier {
  const client = new OAuth2Client(clientId);
  return async (credential) => {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email) throw new Error('Google token has no identity.');
    return { sub: p.sub, email: p.email, emailVerified: p.email_verified === true };
  };
}
