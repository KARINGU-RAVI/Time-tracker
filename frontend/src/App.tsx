import { Component, useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { ErrorState, Skeleton } from '@/components/ui/primitives';
import { ApiError, setUnauthorizedListener } from '@/lib/api';
import { useSession } from '@/lib/queries';
import Calendar from '@/pages/Calendar';
import DayDetail from '@/pages/DayDetail';
import Holidays from '@/pages/Holidays';
import Landing from '@/pages/Landing';
import Leave from '@/pages/Leave';
import ForgotPassword from '@/pages/auth/ForgotPassword';
import ResetPassword from '@/pages/auth/ResetPassword';
import VerifyEmail from '@/pages/auth/VerifyEmail';
import Login from '@/pages/Login';
import Privacy from '@/pages/Privacy';
import More from '@/pages/More';
import Settings from '@/pages/Settings';
import Setup from '@/pages/Setup';
import Summary from '@/pages/Summary';
import Today from '@/pages/Today';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Retry only network hiccups, never a real 4xx answer.
        retry: (count, err) => err instanceof ApiError && err.isNetwork && count < 2,
        refetchOnReconnect: true,
      },
      // Writes are never retried automatically: a retry could duplicate a check-in.
      mutations: { retry: false },
    },
  });
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return <ErrorState message="Something went wrong showing this page." onRetry={() => window.location.reload()} />;
    }
    return this.props.children;
  }
}

function NotFound() {
  return <ErrorState message="That page does not exist." />;
}

/** Pages reached from an emailed link, plus the privacy policy. They work signed in or out, so they sit outside the sign-in check. */
function EmailLinkRoutes() {
  return (
    <Routes>
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/privacy" element={<Privacy />} />
    </Routes>
  );
}

function Gate() {
  const session = useSession();
  const qc = useQueryClient();
  const { pathname } = useLocation();

  // Any 401 from the API means the session ended: re-check who is signed in.
  useEffect(() => {
    setUnauthorizedListener(() => void qc.invalidateQueries({ queryKey: ['session'] }));
    return () => setUnauthorizedListener(null);
  }, [qc]);

  if (pathname === '/verify-email' || pathname === '/reset-password' || pathname === '/privacy') return <EmailLinkRoutes />;

  if (session.isLoading) {
    return (
      <div className="p-6" aria-busy="true">
        <Skeleton className="h-10 w-1/2" />
      </div>
    );
  }
  if (session.error instanceof ApiError && session.error.status === 401) {
    return (
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/signin" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  if (session.isError) {
    return <ErrorState message={session.error.message} onRetry={() => session.refetch()} />;
  }

  // A new account cannot reach the app until the setup wizard is finished (the server enforces this too).
  if (session.data?.mode === 'google' && !session.data.setupComplete) return <Setup />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Today />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="day/:date" element={<DayDetail />} />
        <Route path="leave" element={<Leave />} />
        <Route path="summary" element={<Summary />} />
        <Route path="more" element={<More />} />
        <Route path="holidays" element={<Holidays />} />
        <Route path="settings" element={<Settings />} />
        <Route path="signin" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export default function App({ client = makeQueryClient() }: { client?: QueryClient }) {
  return (
    <Boundary>
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </QueryClientProvider>
    </Boundary>
  );
}
