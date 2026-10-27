const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');

const scenario = JSON.parse(fs.readFileSync('/w/repo/scenario.json', 'utf8'));
const args = process.argv.slice(2);
const codex = args[0] === 'exec';
const home = codex ? '/w/codex' : '/w/claude';
const credential = `${home}/${codex ? 'auth.json' : '.credentials.json'}`;
assert.equal(process.cwd(), '/w/repo');
assert.equal(process.env[codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'], home);
assert.equal(fs.readFileSync(credential, 'utf8'), 'fixture login\n');
assert.throws(() => fs.appendFileSync(credential, 'forbidden'), {
  code: 'EROFS',
});
for (const path of scenario.hidden)
  assert.equal(fs.existsSync(path), false, path);
assert.equal(fs.readFileSync(0).toString('base64'), scenario.prompt);
assert.equal(args[args.indexOf('--model') + 1], scenario.model);
if (codex) {
  assert.deepEqual(args, [
    'exec',
    '--json',
    '--ephemeral',
    '--model',
    scenario.model,
    '--sandbox',
    'workspace-write',
    '--cd',
    '/w/repo',
    '--color',
    'never',
    '-',
  ]);
} else {
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.match(args[args.indexOf('--session-id') + 1], /^[a-f0-9-]{36}$/);
  assert.equal(args[args.indexOf('--settings') + 1], '/w/claude/settings.json');
}
fs.writeFileSync(
  'observed.json',
  JSON.stringify({
    args,
    config: fs.readFileSync(
      `${home}/${codex ? 'config.toml' : 'settings.json'}`,
      'utf8',
    ),
  }),
);
process.stderr.write(Buffer.from(scenario.stderr, 'base64'));
if (scenario.timeout) {
  const child = cp.spawn(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    const server = require('node:net').createServer();
    server.listen(0, '127.0.0.1', () => fs.writeFileSync('/w/repo/listener.json',
      JSON.stringify({port:server.address().port})));
  `,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(Buffer.from(scenario.stream, 'base64'));
  process.exitCode = scenario.exitCode;
}
