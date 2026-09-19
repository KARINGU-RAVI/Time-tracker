import { Check, Circle, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { passwordProblems } from '@oht/engine';
import { Field, TextInput } from '@/components/ui/form';
import { cn } from '@/lib/cn';

/** 0 to 4, only a hint for the user: the server's rules (shared through @oht/engine) are the real check. */
export function strength(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 10) score++;
  if (password.length >= 14) score++;
  if (/[a-z]/.test(password) && /[A-Z0-9]/.test(password)) score++;
  if (/\s|[^A-Za-z0-9]/.test(password) && password.length >= 12) score++;
  return passwordProblems(password).length ? Math.min(score, 1) : score;
}

const STRENGTH_LABELS = ['Weak', 'Weak', 'Fair', 'Good', 'Strong'];

export function PasswordField({
  label,
  value,
  onChange,
  email,
  checklist = false,
  autoComplete,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  email?: string;
  checklist?: boolean;
  autoComplete: 'current-password' | 'new-password';
  error?: string | null;
}) {
  const [shown, setShown] = useState(false);
  const problems = passwordProblems(value, email);
  const longEnough = value.length > 0 && !problems.includes('TOO_SHORT');
  const notCommon = value.length > 0 && !problems.some((p) => p === 'TOO_COMMON' || p === 'ONE_CHARACTER_REPEATED' || p === 'SAME_AS_EMAIL');
  const level = strength(value);
  const rules: Array<[string, boolean]> = [
    ['At least 10 characters', longEnough],
    ['Not a commonly used password', notCommon],
  ];

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} error={error}>
        {(a11y) => (
          <div className="relative">
            <TextInput
              {...a11y}
              type={shown ? 'text' : 'password'}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              autoComplete={autoComplete}
              maxLength={128}
              className="pr-12"
            />
            <button
              type="button"
              onClick={() => setShown((s) => !s)}
              aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
              aria-pressed={shown}
              className="absolute right-1 top-1 grid h-10 w-10 place-items-center rounded-lg text-ink-soft hover:bg-muted"
            >
              {shown ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
            </button>
          </div>
        )}
      </Field>
      {checklist && (
        <>
          <ul className="flex flex-col gap-1 text-sm" aria-label="Password rules">
            {rules.map(([text, ok]) => (
              <li key={text} className={cn('flex items-center gap-2', ok ? 'text-ok' : 'text-ink-soft')}>
                {ok ? <Check size={16} aria-hidden /> : <Circle size={16} aria-hidden />}
                <span>{text}</span>
                <span className="sr-only">{ok ? 'met' : 'not met yet'}</span>
              </li>
            ))}
          </ul>
          {value && (
            <div className="flex items-center gap-2">
              <div className="flex h-1 flex-1 gap-1" aria-hidden>
                {[1, 2, 3, 4].map((i) => (
                  <span key={i} className={cn('flex-1 rounded-full', i <= level ? (level >= 3 ? 'bg-ok' : 'bg-warn') : 'bg-muted')} />
                ))}
              </div>
              <span className="text-xs text-ink-soft">Strength: {STRENGTH_LABELS[level]}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
