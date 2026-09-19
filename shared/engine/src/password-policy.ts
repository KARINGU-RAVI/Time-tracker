/** Password rules shared by the server (which enforces them) and the sign-up form (which shows them as a checklist). */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

// The most commonly used passwords that still satisfy a length-10 rule.
const COMMON = new Set(
  [
    '1234567890', '0123456789', '1234567891', '12345678910', '123456789012', 'password12', 'password123', 'password1234',
    'password01', 'passw0rd123', 'qwertyuiop', 'qwerty1234', 'qwerty12345', 'qwertyuiop123', 'iloveyou12', 'iloveyou123',
    'welcome123', 'welcome1234', 'letmein123', 'admin12345', 'administrator', 'abcdefghij', 'abcd123456', 'abc1234567',
    'changeme123', 'changeme12', 'monkey1234', 'dragon1234', 'football12', 'baseball12', 'superman12', 'trustno1234',
    'zxcvbnm123', 'asdfghjkl1', 'asdfghjkl123', 'internet123', 'sunshine123', 'princess123', 'letmein1234', '1q2w3e4r5t',
    '1qaz2wsx3edc', 'qazwsxedc123', 'office12345', 'officehours', 'officehours1', 'timetracker', 'timetracker1',
  ].map((p) => p.toLowerCase()),
);

export type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'TOO_COMMON' | 'SAME_AS_EMAIL' | 'ONE_CHARACTER_REPEATED';

/** Returns the reasons a password is refused (empty list = acceptable). Shown to the user as a checklist. */
export function passwordProblems(password: string, email?: string): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  if (password.length < PASSWORD_MIN) problems.push('TOO_SHORT');
  if (password.length > PASSWORD_MAX) problems.push('TOO_LONG');
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) problems.push('TOO_COMMON');
  if (/^(.)\1+$/.test(password)) problems.push('ONE_CHARACTER_REPEATED');
  if (email) {
    const e = email.toLowerCase();
    if (lower === e || lower === e.split('@')[0]) problems.push('SAME_AS_EMAIL');
  }
  return problems;
}

export const PASSWORD_MESSAGES: Record<PasswordProblem, string> = {
  TOO_SHORT: `Use at least ${PASSWORD_MIN} characters.`,
  TOO_LONG: `Use at most ${PASSWORD_MAX} characters.`,
  TOO_COMMON: 'That password is too common. Choose another.',
  SAME_AS_EMAIL: 'The password must not be your email address.',
  ONE_CHARACTER_REPEATED: 'The password must not be one repeated character.',
};
