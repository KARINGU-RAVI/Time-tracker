import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/primitives';

const CONTACT = 'karinguravi307@gmail.com';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** Public privacy notice (shown signed in or out; also the privacy policy link for the Google sign-in screen). */
export default function Privacy() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4">
      <Link to="/" className="pt-2 text-sm font-medium text-primary">
        ← Back to Office Hours
      </Link>
      <Card className="flex flex-col gap-6 p-6 text-sm leading-relaxed text-ink">
        <header>
          <h1 className="text-2xl font-semibold">Privacy policy</h1>
          <p className="mt-1 text-ink-soft">Office Hours. Last updated 20 September 2026.</p>
        </header>

        <Section title="What this app is">
          <p>
            Office Hours is a small tool for tracking your own working hours, leave and holidays. Its purpose is to let you record your working hours and leave and see your balances. It is run by an individual, not a company, and it is
            not connected to any employer. Each person&rsquo;s records are private to their own account.
          </p>
        </Section>

        <Section title="Google user data">
          <p>
            If you choose &ldquo;Continue with Google&rdquo;, the app asks Google only for your basic profile: your name, your email address (and whether
            Google has verified it) and your Google account identifier. It does not ask for access to your Gmail, Drive, Calendar, contacts or any other
            Google service.
          </p>
          <ul className="list-disc pl-5">
            <li><strong>How it is used:</strong> only to create your account, to recognise you when you sign in again, and to email you about your account (for example a password reset).</li>
            <li><strong>Sharing:</strong> it is not sold, rented, or given to anyone else, and it is not used for advertising or to build profiles.</li>
            <li><strong>Limited use:</strong> the app&rsquo;s use of information received from Google follows the Google API Services User Data Policy, including its Limited Use requirements.</li>
            <li><strong>Removing it:</strong> deleting your account in Settings erases everything received from Google. You can also remove the app&rsquo;s access in your Google Account settings.</li>
          </ul>
        </Section>

        <Section title="What we store">
          <ul className="list-disc pl-5">
            <li>Your email address and name (from Google, or what you type).</li>
            <li>If you sign up with a password: a scrambled (hashed) form of it. We never store or see the password itself.</li>
            <li>If you use Google sign-in: your Google account&rsquo;s identifier, email, name and whether the email is verified. Nothing else from Google.</li>
            <li>Everything you enter: check-in and check-out times, leave, holidays, work rules, opening balances, your employee ID, designation and business unit if you give them.</li>
            <li>A history of changes you make to your entries, so mistakes can be traced.</li>
            <li>For abuse protection: the network address of sign-in and sign-up attempts, kept for at most two days, and a scrambled form of the email address tried.</li>
          </ul>
        </Section>

        <Section title="Cookies">
          <p>One cookie, needed to keep you signed in. It is not used for tracking or advertising. There are no analytics or advertising tools in this app.</p>
        </Section>

        <Section title="Who else handles data">
          <p>To run the app, these services process data on our behalf:</p>
          <ul className="list-disc pl-5">
            <li><strong>Netlify</strong>: hosts the website and the program that serves it.</li>
            <li><strong>Neon</strong>: stores the database (in Singapore).</li>
            <li><strong>Google</strong>: sign-in with Google.</li>
            <li><strong>Brevo</strong>: sends the verification and password-reset emails (receives your email address).</li>
            <li><strong>Cloudflare Turnstile</strong>: the &ldquo;are you human&rdquo; check when you create an account or reset a password.</li>
          </ul>
          <p>Your data is not sold, not shared for advertising, and not used for anything other than running the app.</p>
        </Section>

        <Section title="Who can see your data">
          <p>
            Other users cannot. The person who runs the app can technically access the database, as with any hosted service, and only does so to keep
            the service working (for example to fix a fault). If you would rather not have your hours stored by an individual, do not use this app.
          </p>
        </Section>

        <Section title="Keeping and deleting your data">
          <ul className="list-disc pl-5">
            <li>Your data is kept until you delete it.</li>
            <li>In Settings, <strong>Delete my account</strong> removes your account and every record immediately.</li>
            <li>You can download a full backup of your data at any time from Settings.</li>
            <li>Accounts that never verify their email are removed after 3 days.</li>
            <li>Our database provider may keep short-lived technical backups after deletion.</li>
          </ul>
        </Section>

        <Section title="How your data is protected">
          <ul className="list-disc pl-5">
            <li>All traffic uses HTTPS.</li>
            <li>Passwords are hashed with a slow, salted algorithm; the sign-in cookie cannot be read by page scripts.</li>
            <li>Every request is checked against your account, so one user can never read or change another user&rsquo;s records.</li>
            <li>Repeated wrong passwords lock an account for a short time, and sign-up and reset requests are rate limited.</li>
          </ul>
          <p>No system is perfectly secure, and we cannot promise it will never be compromised.</p>
        </Section>

        <Section title="Your rights">
          <p>You can see all your data in the app, download a full copy from Settings, correct it by editing your entries, and delete it by deleting your account. To ask about anything else, contact us below.</p>
        </Section>

        <Section title="Age">
          <p>The app is intended for working adults and is not directed at children under 16.</p>
        </Section>

        <Section title="Contact">
          <p>
            Questions or requests about your data: <a className="font-medium text-primary" href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          </p>
        </Section>

        <Section title="Changes">
          <p>If this policy changes, the date at the top changes. Continuing to use the app after a change means you accept it.</p>
        </Section>
      </Card>
    </div>
  );
}
