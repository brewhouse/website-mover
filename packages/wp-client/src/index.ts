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
  private readonly root: string;
  private readonly auth: string;

  constructor({ baseUrl, user, appPassword }: WpClientOptions) {
    this.root = `${baseUrl.replace(/\/$/, '')}/wp-json`;
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
  upload<T = unknown>(data: Uint8Array<ArrayBuffer>, filename: string, contentType: string) {
    return this.send<T>('POST', '/wp/v2/media', undefined, data, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    });
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

    const res = await fetch(url, {
      method,
      headers: { Authorization: this.auth, Accept: 'application/json', ...headers },
      body,
    });
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
  return new WpClient({ baseUrl: `http://localhost:${port}`, user: 'admin', appPassword: env.SEED_LOCAL_APP_PASSWORD });
}
