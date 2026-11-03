import { AuthRoute, authRobots } from '../auth-route.jsx';

export const metadata = {
  title: 'Verify your email',
  description: 'Confirm your email address to activate your Gemies account.',
  robots: authRobots,
};

export default function VerifyPage() {
  return <AuthRoute mode="verify" />;
}
