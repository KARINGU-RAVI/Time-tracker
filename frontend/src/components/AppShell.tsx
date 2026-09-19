import { CalendarDays, Clock, MoreHorizontal, Palmtree, BarChart3, Settings, UserRound, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Banner } from './ui/primitives';

const NAV = [
  { to: '/', label: 'Today', icon: Clock, end: true },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/leave', label: 'Leave', icon: Palmtree },
  { to: '/summary', label: 'Summary', icon: BarChart3 },
  { to: '/more', label: 'More', icon: MoreHorizontal },
] as const;

function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Sidebar on desktop, bottom tab bar on phones (design: 5 tabs). */
export function AppShell() {
  const online = useOnline();
  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-card p-4 md:flex">
        <div className="mb-6 flex items-center gap-3 px-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-on-primary">
            <Clock size={18} aria-hidden />
          </div>
          <div className="text-sm font-semibold leading-tight">
            Office Hours
            <div className="text-xs font-normal text-ink-soft">Attendance Tracker</div>
          </div>
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, ...rest }) => (
            <NavLink
              key={to}
              to={to}
              end={'end' in rest}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium',
                  isActive ? 'bg-primary-soft text-primary' : 'text-ink-soft hover:bg-muted',
                )
              }
            >
              <Icon size={18} aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <NavLink to="/settings" className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-soft hover:bg-muted">
          <Settings size={18} aria-hidden /> Settings
        </NavLink>
        <div className="mt-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-soft">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-muted">
            <UserRound size={16} aria-hidden />
          </span>
          Account
        </div>
      </aside>

      <main className="mx-auto w-full max-w-[1100px] px-4 pb-28 pt-4 md:px-8 md:pb-10 md:pt-8">
        {!online && (
          <Banner tone="warn" className="mb-4">
            <span className="flex items-center gap-2">
              <WifiOff size={16} aria-hidden /> You are offline. Changes will not be saved until you reconnect.
            </span>
          </Banner>
        )}
        <Outlet />
      </main>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {NAV.map(({ to, label, icon: Icon, ...rest }) => (
          <NavLink
            key={to}
            to={to}
            end={'end' in rest}
            className={({ isActive }) =>
              cn('flex flex-col items-center gap-0.5 py-2 text-xs font-medium', isActive ? 'text-primary' : 'text-ink-soft')
            }
          >
            <Icon size={20} aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
