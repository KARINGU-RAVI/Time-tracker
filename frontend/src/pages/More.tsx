import { CalendarHeart, ChevronRight, Settings, Trophy } from 'lucide-react';
import { Link } from 'react-router-dom';
import { InstallCard } from '@/components/InstallCard';
import { Card } from '@/components/ui/primitives';

const ITEMS = [
  { to: '/leaderboard', label: 'Leaderboard', hint: 'See how you compare with colleagues who opt in', icon: Trophy },
  { to: '/holidays', label: 'Holidays', hint: 'Company and optional holidays, import a calendar', icon: CalendarHeart },
  { to: '/settings', label: 'Settings', hint: 'Work rule, appearance, account', icon: Settings },
];

export default function More() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">More</h1>
      <InstallCard />
      {ITEMS.map(({ to, label, hint, icon: Icon }) => (
        <Link key={to} to={to}>
          <Card className="flex items-center gap-3 hover:bg-muted">
            <Icon size={22} className="text-primary" aria-hidden />
            <div className="flex-1">
              <div className="font-medium">{label}</div>
              <div className="text-xs text-ink-soft">{hint}</div>
            </div>
            <ChevronRight size={18} className="text-ink-soft" aria-hidden />
          </Card>
        </Link>
      ))}
    </div>
  );
}
