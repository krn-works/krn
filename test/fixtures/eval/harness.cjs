const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');

const scenario = JSON.parse(fs.readFileSync('/w/repo/scenario.json', 'utf8'));
const args = process.argv.slice(2);
const home = '/w/codex';
const credential = `${home}/auth.json`;
assert.equal(process.cwd(), '/w/repo');
assert.equal(process.env.CODEX_HOME, home);
assert.equal(fs.readFileSync(credential, 'utf8'), 'fixture login\n');
assert.throws(() => fs.appendFileSync(credential, 'forbidden'), {
  code: 'EROFS',
});
for (const path of scenario.hidden)
  assert.equal(fs.existsSync(path), false, path);
assert.equal(fs.readFileSync(0).toString('base64'), scenario.prompt);
assert.equal(args[args.indexOf('--model') + 1], scenario.model);
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
fs.writeFileSync(
  'observed.json',
  JSON.stringify({
    args,
    config: fs.readFileSync(`${home}/config.toml`, 'utf8'),
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
