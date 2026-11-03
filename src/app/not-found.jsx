import { Empty } from '@/components.jsx';

export const metadata = {
  title: 'Page not found',
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <Empty
      title="This page took a different path"
      text="Let’s get you back to the collection."
    />
  );
}
