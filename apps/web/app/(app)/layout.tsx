import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui';
import { logout } from '@/lib/actions';
import { requireUser } from '@/lib/session';

// Every page reads the session and the database per request: never prerendered at build time.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3 sm:px-6">
          <Link href="/" className="text-sm font-semibold">
            Website Mover
          </Link>
          <nav className="flex gap-4 text-sm text-muted">
            <Link href="/" className="hover:text-ink">
              Jobs
            </Link>
            <Link href="/targets" className="hover:text-ink">
              Targets
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-muted sm:inline">{user.name}</span>
            <form action={logout}>
              <Button size="sm" variant="ghost" type="submit">
                Log out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
