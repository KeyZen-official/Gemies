import { AuthRoute, authRobots } from '../auth-route.jsx';

export const metadata = {
  title: 'Resend verification',
  description: 'Request a new Gemies verification email.',
  robots: authRobots,
};

export default function ResendPage() {
  return <AuthRoute mode="resend" />;
}
