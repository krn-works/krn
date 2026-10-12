import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const acceptedShasByTask: Record<string, string> = {
  'LON-130': '6567b4b78fc5c5b8dae1a8536f42450f5c1c79ce',
  'LON-131': 'fd9b1b56e47f3b630d20ed8588107fd824515ca0',
  'LON-133': 'd1bc745f1872a38f31f25f86311a281b010859a3',
  'LON-20': 'a262a5fb97018c479fb682ccc884bfa03100c591',
  'LON-21': 'c7eaee106ad6695405429373df2f252c82bddd47',
  'LON-22': 'a43a99c77e9b311d508b0072f3dddd7a00445e9a',
};
type Manifest = {
  control_tolerance_percent: number;
  tasks: Array<{
    id: string;
    accepted_sha: string;
    base_sha: string;
    exemplar: { source_sha: string; quoted_at_revision: string };
    packet: {
      path: string;
      sha256: string;
      characters: number;
      estimated_tokens: number;
    };
    control: { path: string; sha256: string; characters: number };
    visible_checks: unknown[];
    hidden_checks: Array<{ interface_coupled: boolean }>;
  }>;
};
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const characterCount = (text: string) => [...text].length;

test('Wizard-of-Oz manifest seals packets, controls, and independent checks', () => {
  const leaks: string[] = [];
  const manifestPath = join(root, 'evals/woz/manifest.json');
  let manifest: Manifest | undefined;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  for (const [taskId, acceptedSha] of Object.entries(acceptedShasByTask)) {
    const packetBytes = readFileSync(
      join(root, `evals/woz/packets/${taskId}.md`),
    );
    const packet = packetBytes.toString('utf8');

    for (
      let prefixLength = 7;
      prefixLength <= acceptedSha.length;
      prefixLength += 1
    ) {
      if (
        packet
          .toLowerCase()
          .includes(acceptedSha.slice(0, prefixLength).toLowerCase())
      ) {
        leaks.push(`${taskId}: accepted SHA prefix length ${prefixLength}`);
        break;
      }
    }
  }

  assert.deepEqual(
    leaks,
    [],
    `own accepted-change SHA leaked into packet(s): ${leaks.join(', ')}`,
  );

  // The W0 packets predate the manifest. At that base the observer still scans
  // the original packet bytes; all manifest-specific checks run when present.
  if (!manifest) {
    assert.equal(
      process.env.WOZ_BASE_FALSIFIER,
      '1',
      'manifest is required outside an explicit base falsifier replay',
    );
    return;
  }

  assert.equal(manifest.tasks.length, 6);
  assert.deepEqual(
    manifest.tasks.map((task) => task.id).sort(),
    Object.keys(acceptedShasByTask).sort(),
    'manifest must contain each required task ID exactly once',
  );
  for (const task of manifest.tasks) {
    assert.equal(
      task.accepted_sha,
      acceptedShasByTask[task.id],
      `${task.id} accepted SHA fixture must match the sealed manifest`,
    );
    assert.notEqual(
      task.exemplar.source_sha,
      task.accepted_sha,
      `${task.id} exemplar must be from another change`,
    );
    assert.equal(
      task.exemplar.quoted_at_revision,
      task.base_sha,
      `${task.id} exemplar must quote its base tree`,
    );
    const packetBytes = readFileSync(join(root, task.packet.path));
    const controlBytes = readFileSync(join(root, task.control.path));
    const packet = packetBytes.toString('utf8');
    const control = controlBytes.toString('utf8');
    const packetChars = characterCount(packet);
    const controlChars = characterCount(control);

    assert.equal(
      task.packet.sha256,
      digest(packetBytes),
      `${task.id} packet SHA-256`,
    );
    assert.equal(
      task.packet.characters,
      packetChars,
      `${task.id} packet character count`,
    );
    assert.equal(
      task.packet.estimated_tokens,
      Math.ceil(packetChars / 4),
      `${task.id} packet token estimate`,
    );
    assert.ok(
      task.packet.estimated_tokens <= 2_000,
      `${task.id} packet token limit`,
    );
    assert.equal(
      task.control.sha256,
      digest(controlBytes),
      `${task.id} control SHA-256`,
    );
    assert.equal(
      task.control.characters,
      controlChars,
      `${task.id} control character count`,
    );
    const differencePercent =
      (Math.abs(controlChars - packetChars) / packetChars) * 100;
    assert.ok(
      differencePercent <= manifest.control_tolerance_percent,
      `${task.id} control length difference ${differencePercent.toFixed(2)}% exceeds tolerance`,
    );
    assert.ok(
      task.visible_checks.length > 0 ||
        task.hidden_checks.some(
          (check: { interface_coupled: boolean }) => !check.interface_coupled,
        ),
      `${task.id} needs a visible or interface-independent hidden acceptance check`,
    );
  }
});
