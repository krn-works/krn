import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  crawlSite,
  diffGoldenMaster,
  goldenVerdict,
  importDatabaseFixture,
  normalisePage,
  pageFile,
  parseSitemap,
  writeGoldenMaster,
} from '../../src/repo/golden-master.ts';

const KRN = fileURLToPath(new URL('../../src/cli/krn.mjs', import.meta.url));

test('normalisePage replaces nonces, timestamps and asset hashes and keeps the rest', () => {
  const html = [
    '<link href="/style.css?ver=6.4.2">',
    '<script src="/app.3f9a1c7be2.js"></script>',
    '<a href="/del?_wpnonce=a1b2c3d4e5">x</a>',
    '<input type="hidden" name="_wpnonce" id="_wpnonce" value="9f8e7d6c5b">',
    '<script>var c={"nonce":"abcdef1234","url":"http://localhost:1234/x"};</script>',
    '<time datetime="2026-11-14T10:20:30+00:00">14 Nov</time>',
  ].join('\n');
  const out = normalisePage(html, 'http://localhost:1234/');
  assert.equal(
    out,
    [
      '<link href="/style.css?ver=ASSET">',
      '<script src="/app.HASH.js"></script>',
      '<a href="/del?_wpnonce=NONCE">x</a>',
      '<input type="hidden" name="_wpnonce" id="_wpnonce" value="NONCE">',
      '<script>var c={"nonce":"NONCE","url":"{{base}}/x"};</script>',
      '<time datetime="TIMESTAMP">14 Nov</time>',
    ].join('\n'),
  );
});

test('parseSitemap reads the plainest sitemap and a sitemap index', () => {
  const plain =
    '<urlset><url><loc>http://a.test/</loc></url><url><loc>http://a.test/about/?x=1&amp;y=2</loc></url></urlset>';
  assert.deepEqual(parseSitemap(plain), {
    index: false,
    locs: ['http://a.test/', 'http://a.test/about/?x=1&y=2'],
  });
  const index =
    '<sitemapindex><sitemap><loc>http://a.test/p.xml</loc></sitemap></sitemapindex>';
  assert.deepEqual(parseSitemap(index), {
    index: true,
    locs: ['http://a.test/p.xml'],
  });
});

test('pageFile maps paths to files under the golden master without escaping it', () => {
  assert.equal(pageFile('/'), 'index.html');
  assert.equal(pageFile('/about/'), 'about/index.html');
  assert.equal(pageFile('/page.html'), 'page.html');
  assert.equal(pageFile('/post'), 'post.html');
  assert.equal(pageFile('/s/?q=a b'), 's/index@q_a_20b.html');
  assert.ok(!pageFile('/../../etc/passwd').includes('..'));
});

test('goldenVerdict fails on an undeclared diff and passes a declared one', () => {
  const diff = {
    changed: [{ path: '/about/', line: 2, was: 'a', now: 'b' }],
    added: ['/new/'],
    removed: [],
  };
  assert.equal(goldenVerdict(diff, []).ok, false);
  assert.equal(goldenVerdict(diff, ['/about/']).ok, false);
  const ok = goldenVerdict(diff, ['/about/', '/new/']);
  assert.equal(ok.ok, true);
  assert.match(ok.lines.join('\n'), /declared changed: \/about\//u);
});

/** A sample WordPress-like site: pages rendered from the theme template on disk, per-render values changing on every request. */
function serveSite(theme: string): Promise<{ server: Server; url: string }> {
  let renders = 0;
  const server = createServer((request, response) => {
    renders += 1;
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    if (request.url === '/wp-sitemap.xml') {
      response.setHeader('content-type', 'application/xml');
      response.end(
        '<sitemapindex><sitemap><loc>http://site.example/wp-sitemap-posts.xml</loc></sitemap></sitemapindex>',
      );
    } else if (request.url === '/wp-sitemap-posts.xml') {
      response.end(
        '<urlset><url><loc>http://site.example/</loc></url><url><loc>http://site.example/about/</loc></url></urlset>',
      );
    } else if (request.url === '/' || request.url === '/about/') {
      const template = readFileSync(join(theme, 'page.html'), 'utf8');
      response.end(
        template
          .replaceAll('{{title}}', request.url)
          .replaceAll('{{nonce}}', `n${renders}x${renders * 7919}abcdef`)
          .replaceAll('{{now}}', new Date(Date.now() + renders).toISOString())
          .replaceAll('{{base}}', base),
      );
    } else {
      response.statusCode = 404;
      response.end('nope');
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    ),
  );
}

function krn(
  args: string[],
  cwd: string,
): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [KRN, ...args], { cwd });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (status) => resolve({ status, out }));
  });
}

const TEMPLATE = [
  '<html><head><title>{{title}}</title>',
  '<link rel="stylesheet" href="{{base}}/style.css?ver=6.4.2"></head>',
  '<body><h1>Welcome</h1>',
  '<form><input type="hidden" name="_wpnonce" value="{{nonce}}"></form>',
  '<footer>rendered <time datetime="{{now}}">now</time></footer>',
  '</body></html>',
].join('\n');

test('golden master gate: green on a no-op change, red on a template edit, green once declared (real HTTP server)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'golden-'));
  const theme = join(repo, 'wp-content', 'themes', 'sample');
  mkdirSync(theme, { recursive: true });
  writeFileSync(join(theme, 'page.html'), TEMPLATE);
  mkdirSync(join(repo, 'golden-master'));
  writeFileSync(
    join(repo, 'golden-master', 'config.json'),
    JSON.stringify({ sitemap: '/wp-sitemap.xml' }),
  );
  const { server, url } = await serveSite(theme);
  try {
    const base = ['--url', url, '--root', repo];
    const recorded = await krn(['repo', 'golden', 'record', ...base], repo);
    assert.equal(recorded.status, 0, recorded.out);
    assert.match(recorded.out, /golden recorded 2 pages/u);
    const stored = readFileSync(
      join(repo, 'golden-master', 'pages', 'about', 'index.html'),
      'utf8',
    );
    assert.match(stored, /value="NONCE"/u);
    assert.match(stored, /datetime="TIMESTAMP"/u);
    assert.match(stored, /style\.css\?ver=ASSET/u);

    const noop = await krn(['repo', 'golden', 'check', ...base], repo);
    assert.equal(noop.status, 0, noop.out);
    assert.match(noop.out, /golden ok: 2 pages/u);

    writeFileSync(
      join(theme, 'page.html'),
      TEMPLATE.replace('<h1>Welcome</h1>', '<h1>Welcome back</h1>'),
    );
    const red = await krn(['repo', 'golden', 'check', ...base], repo);
    assert.equal(red.status, 1, red.out);
    assert.match(red.out, /golden FAIL changed: \/ line 3/u);
    assert.match(red.out, /now: <body><h1>Welcome back<\/h1>/u);

    const declared = await krn(
      [
        'repo',
        'golden',
        'check',
        ...base,
        '--declare',
        '/',
        '--declare',
        '/about/',
      ],
      repo,
    );
    assert.equal(declared.status, 0, declared.out);
    assert.match(declared.out, /golden declared changed: \//u);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a page missing from the crawl is a removed diff and a new page an added diff', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'golden-'));
  try {
    writeGoldenMaster(
      repo,
      new Map([
        ['/', 'home'],
        ['/gone/', 'gone'],
      ]),
    );
    const diff = diffGoldenMaster(
      repo,
      new Map([
        ['/', 'home'],
        ['/fresh/', 'fresh'],
      ]),
    );
    assert.deepEqual(diff.added, ['/fresh/']);
    assert.deepEqual(diff.removed, ['gone/index.html']);
    assert.equal(goldenVerdict(diff, []).ok, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the database fixture is imported with wp db import before the crawl', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'golden-'));
  const theme = join(repo, 'theme');
  mkdirSync(theme);
  writeFileSync(join(theme, 'page.html'), TEMPLATE);
  mkdirSync(join(repo, 'golden-master'));
  writeFileSync(
    join(repo, 'golden-master', 'config.json'),
    JSON.stringify({
      sitemap: '/wp-sitemap.xml',
      dbFixture: 'golden-master/fixture.sql',
    }),
  );
  const capture = join(repo, 'wp-argv.txt');
  const wp = join(repo, 'wp');
  writeFileSync(wp, `#!/bin/sh\necho "$@" > '${capture}'\n`);
  chmodSync(wp, 0o755);
  const { server, url } = await serveSite(theme);
  try {
    const pages = await crawlSite(repo, url, wp);
    assert.deepEqual([...pages.keys()], ['/', '/about/']);
    assert.equal(
      readFileSync(capture, 'utf8').trim(),
      'db import golden-master/fixture.sql',
    );
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the real wp-cli takes the import call and its refusal in a directory without WordPress is reported', () => {
  const probe = spawnSync('wp', ['help', 'db', 'import'], { encoding: 'utf8' });
  // Hosts without wp-cli (CI) cannot drive the real receiver; the host that has it does.
  if (probe.error !== undefined) return;
  assert.match(probe.stdout, /wp db import/u);
  assert.match(probe.stdout, /\[<file>\]/u);
  const repo = mkdtempSync(join(tmpdir(), 'golden-'));
  try {
    assert.throws(
      () => importDatabaseFixture(repo, 'fixture.sql'),
      /wp db import fixture\.sql failed \(exit [1-9]/u,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
