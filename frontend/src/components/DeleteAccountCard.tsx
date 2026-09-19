import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PasswordField } from '@/components/auth/PasswordField';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, TextInput } from '@/components/ui/form';
import { Banner, Card, CardTitle } from '@/components/ui/primitives';
import { ApiError, http, toApiError } from '@/lib/api';

/** Permanent deletion of the account and every record. Guarded by typing DELETE (and the password, when there is one). */
export function DeleteAccountCard({ hasPassword }: { hasPassword: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (busy) return;
    setOpen(false);
    setTyped('');
    setPassword('');
    setError(null);
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await http.delete('/account', { data: { confirm: 'DELETE', password: hasPassword ? password : undefined } });
      await qc.invalidateQueries();
      window.location.assign('/');
    } catch (e) {
      const err = toApiError(e);
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle>Delete account</CardTitle>
      <p className="text-sm text-ink-soft">Permanently removes your account and all your hours, leave and holidays. This cannot be undone. Download a backup first if you want to keep a copy.</p>
      <Button variant="destructiveText" className="mt-3" onClick={() => setOpen(true)}>
        <Trash2 size={16} aria-hidden /> Delete my account
      </Button>
      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())} title="Delete your account?" description="Everything is removed immediately and cannot be recovered.">
        <div className="flex flex-col gap-4">
          {hasPassword && <PasswordField label="Your password" value={password} onChange={setPassword} autoComplete="current-password" />}
          <Field label="Type DELETE to confirm">{(a) => <TextInput {...a} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />}</Field>
          {error && <Banner tone="bad">{error}</Banner>}
          <Button variant="danger" size="lg" disabled={typed !== 'DELETE' || busy || (hasPassword && !password)} onClick={remove}>
            {busy ? 'Deleting…' : 'Delete everything'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
