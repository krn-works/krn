import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const characterCount = (text: string) => [...text].length;

test('Wizard-of-Oz manifest seals packets, controls, and independent checks', () => {
  const manifest = JSON.parse(
    readFileSync(join(root, 'evals/woz/manifest.json'), 'utf8'),
  );
  const leaks: string[] = [];

  assert.equal(manifest.tasks.length, 6);
  for (const task of manifest.tasks) {
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

    for (
      let prefixLength = 7;
      prefixLength <= task.accepted_sha.length;
      prefixLength += 1
    ) {
      if (
        packet
          .toLowerCase()
          .includes(task.accepted_sha.slice(0, prefixLength).toLowerCase())
      ) {
        leaks.push(`${task.id}: accepted SHA prefix length ${prefixLength}`);
        break;
      }
    }

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

  assert.deepEqual(
    leaks,
    [],
    `own accepted-change SHA leaked into packet(s): ${leaks.join(', ')}`,
  );
});
