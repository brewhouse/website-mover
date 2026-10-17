import { safeFetch } from '@wm/net';

export interface WpClientOptions {
  baseUrl: string;
  user: string;
  appPassword: string;
}

export class WpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

/** Minimal WordPress REST client using an Application Password. */
export class WpClient {
  readonly baseUrl: string;
  private readonly root: string;
  private readonly auth: string;

  constructor({ baseUrl, user, appPassword }: WpClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.root = `${this.baseUrl}/wp-json`;
    this.auth = `Basic ${Buffer.from(`${user}:${appPassword.replace(/\s+/g, '')}`).toString('base64')}`;
  }

  get<T = unknown>(path: string, query?: Record<string, string | number>) {
    return this.request<T>('GET', path, undefined, query);
  }

  post<T = unknown>(path: string, body: unknown) {
    return this.request<T>('POST', path, body);
  }

  delete<T = unknown>(path: string, query?: Record<string, string | number>) {
    return this.request<T>('DELETE', path, undefined, query);
  }

  /** Uploads a file to the media library. */
  upload<T = unknown>(data: Uint8Array<ArrayBuffer>, filename: string, contentType: string, query?: Record<string, string | number>) {
    // Header values must be ASCII; WordPress sanitizes the name again anyway.
    const ascii = filename.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'file';
    return this.send<T>('POST', '/wp/v2/media', query, data, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${ascii}"`,
    });
  }

  /** Posts a multipart form (e.g. a font file to the Font Library). */
  async postForm<T = unknown>(path: string, form: FormData) {
    // Encoded once here (with its boundary), so the request is plain bytes like an upload.
    const encoded = new Request('http://localhost/', { method: 'POST', body: form });
    const body = new Uint8Array(await encoded.arrayBuffer());
    return this.send<T>('POST', path, undefined, body, { 'Content-Type': encoded.headers.get('content-type')! });
  }

  request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number>): Promise<T> {
    return body === undefined
      ? this.send<T>(method, path, query)
      : this.send<T>(method, path, query, JSON.stringify(body), { 'Content-Type': 'application/json' });
  }

  private async send<T>(
    method: string,
    path: string,
    query: Record<string, string | number> | undefined,
    body?: string | Uint8Array<ArrayBuffer>,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(this.root + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));

    const init = { method, headers: { Authorization: this.auth, Accept: 'application/json', ...headers }, body };
    // Reads are retried on network errors. Writes are not (a dropped connection may still have
    // been processed); callers make writes idempotent instead.
    const attempts = method === 'GET' ? 3 : 1;
    let res: Awaited<ReturnType<typeof safeFetch>> | undefined;
    for (let attempt = 1; !res; attempt++) {
      try {
        res = await safeFetch(url, init);
      } catch (err) {
        if (attempt >= attempts) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) {
      const err = (json ?? {}) as { code?: string; message?: string };
      throw new WpError(res.status, err.code ?? 'http_error', err.message ?? text.slice(0, 200), json ?? text);
    }
    return json as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Client for the local Docker seed (e2e/seed), configured from .env. */
export function localSeedClient(env: NodeJS.ProcessEnv = process.env): WpClient {
  const port = env.SEED_LOCAL_PORT ?? '8088';
  if (!env.SEED_LOCAL_APP_PASSWORD) throw new Error('SEED_LOCAL_APP_PASSWORD is not set in .env');
  return new WpClient({ baseUrl: `http://localhost:${port}`, user: 'wm-local', appPassword: env.SEED_LOCAL_APP_PASSWORD });
}
