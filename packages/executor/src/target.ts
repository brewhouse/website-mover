import { localSeedClient, WpError, type WpClient } from '@wm/wp-client';
import type { TargetEntity, TargetInfo } from '@wm/planner';

export type TargetName = TargetInfo['name'];

interface BridgeStatus {
  wordpress: string;
  theme: { stylesheet: string };
  active_plugins: Record<string, string>;
  disabled_blocks: string[];
  permalinks: string;
  reserved_slugs: string[];
}

/** REST client for a target. M1 runs against the local Docker seed only. */
export function connectTarget(name: TargetName): WpClient {
  if (name !== 'local') {
    throw new Error('Only --target local is enabled in M1. The hosted seed needs the bridge plugin installed first.');
  }
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
    },
    existing,
  };
}
