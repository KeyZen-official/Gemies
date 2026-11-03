import { AuthRoute, authRobots } from '../auth-route.jsx';

export const metadata = {
  title: 'Forgot your password',
  description: 'Request a password reset link for your Gemies account.',
  robots: authRobots,
};

export default function ForgotPage() {
  return <AuthRoute mode="forgot" />;
}
