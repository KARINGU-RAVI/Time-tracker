import { Smartphone } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/primitives';
import { isAndroid, isInstalled, isIos, promptInstall, useCanInstall } from '@/lib/install';

/** Put the app on the home screen. Shows nothing when it is already installed, or on a computer that cannot install it. */
export function InstallCard() {
  const canInstall = useCanInstall();
  const [declined, setDeclined] = useState(false);
  if (isInstalled()) return null;

  const ios = isIos();
  const android = isAndroid();
  if (!canInstall && !ios && !android) return null;

  return (
    <Card className="flex items-start gap-3">
      <Smartphone size={22} className="mt-0.5 shrink-0 text-primary" aria-hidden />
      <div className="flex-1">
        <div className="font-medium">Install the app</div>
        <p className="mt-0.5 text-xs text-ink-soft">Open Office Hours from your home screen, full screen, like any other app.</p>
        {canInstall ? (
          <Button className="mt-3" size="sm" onClick={async () => setDeclined((await promptInstall()) === 'dismissed')}>
            Install app
          </Button>
        ) : ios ? (
          <p className="mt-2 text-sm">
            In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
          </p>
        ) : (
          <p className="mt-2 text-sm">
            Open the browser menu (<strong>⋮</strong>) and tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.
          </p>
        )}
        {declined && <p className="mt-2 text-xs text-ink-soft">No problem. You can install it any time from here.</p>}
      </div>
    </Card>
  );
}
