import { CalendarDays, Clock3, Lock, Scale } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { Card } from '@/components/ui/primitives';

const FEATURES = [
  { icon: Clock3, title: 'Record your day', text: 'Check in and out as often as you like, or add sessions by hand. See what you have worked, what is left, and when you can leave.' },
  { icon: Scale, title: 'Know your balance', text: 'Weekly and monthly totals against your required hours, with overtime and shortfall worked out for you.' },
  { icon: CalendarDays, title: 'Leave and holidays', text: 'Monthly leave credits, optional holidays, carry-forward and a holiday calendar, so you always know what you have left.' },
  { icon: Lock, title: 'Private to you', text: 'Your records belong to your account alone. Download a backup or delete everything whenever you want.' },
];

/** The public front page for visitors who are not signed in. It says what the app is for, before asking anyone to sign in. */
export default function Landing() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 p-4 sm:p-8">
      <header className="flex items-center justify-between gap-3 pt-2">
        <div className="flex items-center gap-3">
          <Logo size={40} />
          <span className="text-lg font-semibold">Office Hours</span>
        </div>
        <Link to="/signin" className="rounded-full border border-line px-4 py-2 text-sm font-semibold hover:bg-muted">
          Sign in
        </Link>
      </header>

      <main className="flex flex-col gap-8">
        <section className="flex flex-col gap-4">
          <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">Track your working hours, leave and balance.</h1>
          <p className="text-base leading-relaxed text-ink-soft">
            Office Hours is a personal attendance and leave tracker for people who work set hours. You record when you start and stop, and the app works
            out the rest: hours worked today and this week, hours still to do, overtime, monthly leave credits, holidays and your remaining leave balance.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link to="/signin?mode=signup" className="inline-flex h-12 items-center rounded-full bg-primary px-6 font-semibold text-on-primary hover:bg-primary/90">
              Create a free account
            </Link>
            <Link to="/signin" className="inline-flex h-12 items-center rounded-full border border-line px-6 font-semibold hover:bg-muted">
              Sign in
            </Link>
          </div>
        </section>

        <section aria-labelledby="what" className="grid gap-4 sm:grid-cols-2">
          <h2 id="what" className="sr-only">What it does</h2>
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <Card key={title} className="flex flex-col gap-2">
              <Icon size={22} className="text-primary" aria-hidden />
              <h3 className="font-semibold">{title}</h3>
              <p className="text-sm leading-relaxed text-ink-soft">{text}</p>
            </Card>
          ))}
        </section>

        <section aria-labelledby="who" className="flex flex-col gap-2">
          <h2 id="who" className="text-xl font-semibold">Who it is for</h2>
          <p className="text-sm leading-relaxed text-ink-soft">
            Anyone who wants an accurate, private record of their own hours and leave: employees on fixed daily and weekly hours, with monthly leave credits
            and a holiday list. You choose your own hours, working days and leave rules when you first sign in. It is not an employer tool: nobody else sees
            your records.
          </p>
        </section>

        <section aria-labelledby="signin-how" className="flex flex-col gap-2">
          <h2 id="signin-how" className="text-xl font-semibold">Signing in and your data</h2>
          <p className="text-sm leading-relaxed text-ink-soft">
            You can sign in with a Google account or with an email address and password. With Google sign-in the app receives only your name, email address and
            Google account identifier, which it uses to create and secure your account. Read exactly what is stored and how it is used in the{' '}
            <Link to="/privacy" className="font-medium text-primary underline">privacy policy</Link>.
          </p>
        </section>
      </main>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-sm text-ink-soft">
        <span>© Office Hours</span>
        <Link to="/privacy" className="font-medium text-primary">Privacy policy</Link>
      </footer>
    </div>
  );
}
