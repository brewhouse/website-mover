import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';
import { LoginForm } from './login-form';

export const metadata = { title: 'Log in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await currentUser()) redirect('/');
  const { next } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold">Website Mover</div>
          <p className="mt-1 text-sm text-muted">Log in to review and run migrations.</p>
        </div>
        <LoginForm next={next ?? '/'} />
      </div>
    </main>
  );
}
