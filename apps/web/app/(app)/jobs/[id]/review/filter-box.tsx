'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { inputClass } from '@/components/ui';

/** Filters the current tab's rows (the `q` search parameter). */
export function FilterBox({ placeholder }: { placeholder: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState(params.get('q') ?? '');
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const next = new URLSearchParams(params);
        if (value) next.set('q', value);
        else next.delete('q');
        next.delete('page');
        router.replace(`${pathname}?${next}`);
      }}
    >
      <input type="search" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} aria-label="Filter" className={`${inputClass} w-64 py-1.5`} />
    </form>
  );
}
