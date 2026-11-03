import { AuthRoute, authRobots } from '../auth-route.jsx';

export const metadata = {
  title: 'Create account',
  description: 'Join the Gemies community.',
  robots: authRobots,
};

export default function RegisterPage() {
  return <AuthRoute mode="register" />;
}
