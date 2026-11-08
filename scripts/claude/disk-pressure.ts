import { statfsSync, statSync } from 'node:fs';

// Below this free percentage builds, installs and git writes start failing;
// the operator's floor for every working disk.
const floor = 20;

export type Volume = {
  path: string;
  device: number;
  bsize: number;
  blocks: number;
  bavail: number;
};

// The filesystem behind each path; a path that cannot be read adds nothing.
export function probe(paths: readonly string[]): Volume[] {
  const volumes: Volume[] = [];
  for (const path of paths) {
    try {
      const { bsize, blocks, bavail } = statfsSync(path);
      volumes.push({ path, device: statSync(path).dev, bsize, blocks, bavail });
    } catch {
      /* An unreadable path is not a reason to warn or to fail. */
    }
  }
  return volumes;
}

// One line per device under the floor, none while every disk is healthy.
// Equal sizes do not mean one disk, so paths share a line only when they share
// a device; btrfs subvolumes get their own device and may print twice.
export function pressureLines(volumes: readonly Volume[]): string[] {
  const seen = new Set<number>();
  const lines: string[] = [];
  for (const volume of volumes) {
    if (volume.blocks <= 0 || seen.has(volume.device)) continue;
    seen.add(volume.device);
    // Block counts stay far below 2^53 / 100, so this integer math is exact.
    if (volume.bavail * 100 >= floor * volume.blocks) continue;
    const gib = (count: number) =>
      ((count * volume.bsize) / 2 ** 30).toFixed(1);
    lines.push(
      `Disk: ${volume.path} ${Math.floor((volume.bavail * 100) / volume.blocks)}% free (${gib(volume.bavail)} of ${gib(volume.blocks)} GiB), below the ${floor}% floor`,
    );
  }
  return lines;
}
