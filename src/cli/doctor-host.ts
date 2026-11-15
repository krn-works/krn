import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HostFacts {
  platform: string;
  nodeVersion: string;
  tmpPath: string;
  /** Text of the product's mise.toml, or null when unreadable. */
  miseToml: string | null;
}

export function readHostFacts(productRoot: string): HostFacts {
  let miseToml: string | null = null;
  try {
    miseToml = readFileSync(join(productRoot, 'mise.toml'), 'utf8');
  } catch (error) {
    // A missing file is the expected case; any other read failure is real.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    tmpPath: tmpdir(),
    miseToml,
  };
}

/** `krn doctor` host section: every requirement the CLI names. */
export function hostReport(facts: HostFacts): {
  text: string;
  exitCode: number;
} {
  const pin = /^node\s*=\s*"([^"]+)"/mu.exec(facts.miseToml ?? '')?.[1];
  const text = [
    `host=${facts.platform}`,
    'lock=exclusive-link',
    `tmp=${facts.tmpPath} (set TMPDIR to a disk path for large runs)`,
    `node=${facts.nodeVersion}`,
    `node-pin=${pin ?? 'unknown'}`,
    `node-match=${pin === undefined ? 'unknown' : pin === facts.nodeVersion ? 'yes' : 'no'}`,
    '',
  ].join('\n');
  return { text, exitCode: 0 };
}
