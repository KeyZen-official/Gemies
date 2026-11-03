import { AuthRoute, authRobots } from '../auth-route.jsx';

export const metadata = {
  title: 'Sign in',
  description: 'Sign in to your Gemies account.',
  robots: authRobots,
};

export default function LoginPage() {
  return <AuthRoute mode="login" />;
}
