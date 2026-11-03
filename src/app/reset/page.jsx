import { AuthRoute, authRobots } from '../auth-route.jsx';

export const metadata = {
  title: 'Set a new password',
  description: 'Choose a new password for your Gemies account.',
  robots: authRobots,
};

export default function ResetPage() {
  return <AuthRoute mode="reset" />;
}
