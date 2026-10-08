import { CodexHost } from '../src/hosts/codex.ts';

if (process.env.KRN_LIVE !== '1') {
  process.stderr.write('Set KRN_LIVE=1 to run a live Luna session.\n');
  process.exit(2);
}

const prompt = process.argv.slice(2).join(' ').trim();
if (!prompt) {
  process.stderr.write('Usage: KRN_LIVE=1 npm run live -- "prompt"\n');
  process.exit(2);
}

const host = new CodexHost();
const session = await host.start({
  cwd: process.cwd(),
  model: 'gpt-6-luna',
  prompt,
  limits: { timeoutMs: 15 * 60 * 1000 },
});
const result = await session.wait();
process.stdout.write(
  `model=gpt-6-luna input_tokens=${result.usage.inputTokens} output_tokens=${result.usage.outputTokens} total_tokens=${result.usage.totalTokens}\n`,
);
if (result.exitCode !== 0 || result.signal) {
  process.stderr.write(
    `Codex process did not exit cleanly (session ${result.sessionId}).\n`,
  );
  process.exitCode = 1;
}
