import { Suspense } from 'react';
import { AuthPage } from '@/account.jsx';
import { Loading } from '@/components.jsx';

// AuthPage reads ?next= on sign-in and ?token= on reset and verify, so it
// needs a Suspense boundary for the query string.
export function AuthRoute({ mode }) {
  return (
    <Suspense fallback={<Loading />}>
      <AuthPage mode={mode} />
    </Suspense>
  );
}

// Auth screens should never be indexed.
export const authRobots = { index: false, follow: false };
