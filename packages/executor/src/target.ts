import { localSeedClient, WpError, type WpClient } from '@wm/wp-client';
import type { TargetEntity, TargetInfo } from '@wm/planner';

export type TargetName = TargetInfo['name'];

interface BridgeStatus {
  wordpress: string;
  theme: { stylesheet: string };
  active_plugins: Record<string, string>;
  disabled_blocks: string[];
  permalinks: string;
  timezone: string;
  reserved_slugs: string[];
}

/** REST client for the local Docker seed (.env). Saved targets are built from their stored credentials. */
export function connectTarget(name: TargetName): WpClient {
  if (name !== 'local') throw new Error(`Only the local seed is configured from .env; "${name}" is a saved target`);
  return localSeedClient();
}

/** What the planner needs to know about the target, read through the bridge. */
export async function probeTarget(
  client: WpClient,
  name: TargetName,
): Promise<{ info: TargetInfo; existing: TargetEntity[] }> {
  const status = await client.get<BridgeStatus>('/website-mover/v1/status').catch((err: unknown) => {
    if (err instanceof WpError && err.status === 404) {
      throw new Error(`The Website Mover Bridge plugin is not active on ${client.baseUrl}`);
    }
    throw err;
  });
  const existing = await client.get<TargetEntity[]>('/website-mover/v1/entities');
  const settings = await client.get<{ description?: string }>('/wp/v2/settings', { _fields: 'description' });
  return {
    info: {
      name,
      url: client.baseUrl,
      wordpress: status.wordpress,
      theme: status.theme.stylesheet,
      permalinks: status.permalinks,
      disabledBlocks: status.disabled_blocks,
      reservedSlugs: status.reserved_slugs,
      redirection: 'redirection' in status.active_plugins,
      timezone: status.timezone,
      tagline: settings.description ?? '',
    },
    existing,
  };
}
