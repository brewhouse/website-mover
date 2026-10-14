/**
 * The slug WordPress would store for a title or source path (sanitize_title, "save" context),
 * so the plan predicts the real URL.
 */
export function wpSlug(input: string, maxLength = 90): string {
  let s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[ –—/]/g, '-') // nbsp, en/em dash, slash
    .replace(/[‘’“”'"]/g, '')
    .replace(/×/g, 'x')
    .replace(/&.+?;/g, '')
    .replace(/\./g, '-')
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (s.length > maxLength) s = s.slice(0, maxLength).replace(/-[^-]*$/, '') || s.slice(0, maxLength);
  return s;
}

/** Hands out slugs that are unique across everything already taken. */
export class SlugRegistry {
  private readonly taken = new Set<string>();

  constructor(reserved: Iterable<string>) {
    for (const s of reserved) this.taken.add(s.split('/')[0]!);
  }

  /** `preferred` if free, else `preferred-2`, `preferred-3`, ... */
  claim(preferred: string): string {
    const base = preferred || 'untitled';
    let slug = base;
    for (let n = 2; this.taken.has(slug); n++) slug = `${base}-${n}`;
    this.taken.add(slug);
    return slug;
  }
}
