// HTTP golden master of a site repository: crawl the sitemap of a running site, normalise what changes
// on every render (nonces, timestamps, asset hashes), store the HTML under the repository and fail on any
// page diff the task does not declare. It protects behaviour no unit test covers.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

export const GOLDEN_DIRECTORY = 'golden-master';
const PAGES_DIRECTORY = 'pages';
const CONFIG_FILE = 'config.json';

const configSchema = z.object({
  /** Sitemap path on the site, e.g. /wp-sitemap.xml. */
  sitemap: z.string().startsWith('/').default('/sitemap.xml'),
  /** SQL fixture (wp db export) imported with `wp db import` before every crawl; omitted: no import. */
  dbFixture: z.string().min(1).optional(),
});
export type GoldenConfig = z.infer<typeof configSchema>;

export class GoldenMasterError extends Error {}

/** The golden-master config of a repository (defaults when golden-master/config.json is absent). */
export function readGoldenConfig(root: string): GoldenConfig {
  const file = join(root, GOLDEN_DIRECTORY, CONFIG_FILE);
  if (!existsSync(file)) return configSchema.parse({});
  const parsed = configSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success)
    throw new GoldenMasterError(
      `${GOLDEN_DIRECTORY}/${CONFIG_FILE}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  return parsed.data;
}

const ISO_TIMESTAMP =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gu;
const NONCE_VALUE = /(nonce["']?\s*[=:]\s*["']?)[0-9A-Za-z]{6,}/giu;
const NONCE_INPUT =
  /(name=["'][^"']*nonce[^"']*["'][^>]*?\svalue=["'])[^"']*/giu;
const VERSION_QUERY = /([?&](?:ver|v|version|hash|cb|_)=)[^&"'\s<>)]+/gu;
const HASHED_FILE =
  /\.[0-9a-f]{8,32}\.(js|css|mjs|png|jpe?g|gif|svg|webp|woff2?)\b/gu;

/** The page with every per-render value replaced by a fixed token; the base URL becomes {{base}}. */
export function normalisePage(html: string, baseUrl?: string): string {
  let text = html;
  if (baseUrl !== undefined)
    text = text.split(baseUrl.replace(/\/$/u, '')).join('{{base}}');
  return text
    .replace(NONCE_VALUE, '$1NONCE')
    .replace(NONCE_INPUT, '$1NONCE')
    .replace(ISO_TIMESTAMP, 'TIMESTAMP')
    .replace(VERSION_QUERY, '$1ASSET')
    .replace(HASHED_FILE, '.HASH.$1');
}

/** The `<loc>` entries of a sitemap or sitemap index, with whether the document is an index. */
export function parseSitemap(xml: string): { index: boolean; locs: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/gu)].map((match) =>
    (match[1] ?? '').replace(/&amp;/gu, '&'),
  );
  return { index: /<sitemapindex[\s>]/u.test(xml), locs };
}

/** Path plus query of a sitemap URL: the site is crawled at the given base, whatever host the sitemap names. */
function pagePath(loc: string): string {
  const url = new URL(loc, 'http://site.invalid');
  return `${url.pathname}${url.search}`;
}

async function fetchText(
  url: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { redirect: 'follow' });
  return { status: response.status, body: await response.text() };
}

/** Page paths of the site's sitemap (nested sitemaps followed to depth 3), sorted and unique. */
export async function sitemapPaths(
  baseUrl: string,
  sitemap: string,
): Promise<string[]> {
  const base = baseUrl.replace(/\/$/u, '');
  const seen = new Set<string>();
  const pages = new Set<string>();
  const visit = async (path: string, depth: number): Promise<void> => {
    if (seen.has(path) || depth > 3) return;
    seen.add(path);
    const { status, body } = await fetchText(`${base}${path}`);
    if (status !== 200)
      throw new GoldenMasterError(`sitemap ${path} answered HTTP ${status}`);
    const parsed = parseSitemap(body);
    for (const loc of parsed.locs)
      if (parsed.index) await visit(pagePath(loc), depth + 1);
      else pages.add(pagePath(loc));
  };
  await visit(sitemap, 0);
  return [...pages].sort();
}

/** Normalised HTML per page path. A non-200 page is stored with its status on the first line. */
export async function crawlPages(
  baseUrl: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const base = baseUrl.replace(/\/$/u, '');
  const pages = new Map<string, string>();
  for (const path of paths) {
    const { status, body } = await fetchText(`${base}${path}`);
    const html = normalisePage(body, base);
    pages.set(
      path,
      status === 200
        ? html
        : `<!-- krn-golden-master status=${status} -->\n${html}`,
    );
  }
  return pages;
}

/** Relative file of a page under golden-master/pages: directory-style paths become index.html. */
export function pageFile(path: string): string {
  const url = new URL(path, 'http://site.invalid');
  const safe = (segment: string) => segment.replace(/[^A-Za-z0-9._-]/gu, '_');
  const segments = url.pathname.split('/').filter(Boolean).map(safe);
  const query = url.search === '' ? '' : `@${safe(url.search.slice(1))}`;
  const last = segments.at(-1);
  if (url.pathname.endsWith('/') || last === undefined)
    return [...segments, `index${query}.html`].join('/');
  return [...segments.slice(0, -1), `${last}${query}`]
    .join('/')
    .concat(/\.html?$/u.test(last) && query === '' ? '' : '.html');
}

function storedPages(root: string): Map<string, string> {
  const dir = join(root, GOLDEN_DIRECTORY, PAGES_DIRECTORY);
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }))
      if (entry.isDirectory()) walk(join(current, entry.name));
      else
        files.set(
          relative(dir, join(current, entry.name)).split(sep).join('/'),
          readFileSync(join(current, entry.name), 'utf8'),
        );
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

/** Replace the stored golden master with the crawled pages; returns how many pages it holds. */
export function writeGoldenMaster(
  root: string,
  pages: ReadonlyMap<string, string>,
): number {
  const dir = resolve(root, GOLDEN_DIRECTORY, PAGES_DIRECTORY);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, html] of pages) {
    const file = resolve(dir, pageFile(path));
    if (!file.startsWith(`${dir}${sep}`))
      throw new GoldenMasterError(`page ${path} escapes ${GOLDEN_DIRECTORY}/`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  }
  return pages.size;
}

export interface GoldenDiff {
  /** Pages whose stored HTML differs, with the first differing line of each. */
  changed: Array<{ path: string; line: number; was: string; now: string }>;
  added: string[];
  removed: string[];
}

/** Compare crawled pages with the stored golden master. */
export function diffGoldenMaster(
  root: string,
  pages: ReadonlyMap<string, string>,
): GoldenDiff {
  const stored = storedPages(root);
  const diff: GoldenDiff = { changed: [], added: [], removed: [] };
  const seen = new Set<string>();
  for (const [path, html] of pages) {
    const file = pageFile(path);
    seen.add(file);
    const before = stored.get(file);
    if (before === undefined) diff.added.push(path);
    else if (before !== html) {
      const was = before.split('\n');
      const now = html.split('\n');
      let line = 0;
      while (line < was.length && was[line] === now[line]) line += 1;
      diff.changed.push({
        path,
        line: line + 1,
        was: was[line] ?? '',
        now: now[line] ?? '',
      });
    }
  }
  for (const file of stored.keys())
    if (!seen.has(file)) diff.removed.push(file);
  return diff;
}

export interface GoldenVerdict {
  ok: boolean;
  lines: string[];
}

/** The gate verdict: every diff must be declared (page path, or the stored file for a removed page). */
export function goldenVerdict(
  diff: GoldenDiff,
  declared: readonly string[],
): GoldenVerdict {
  const allowed = new Set(declared);
  const lines: string[] = [];
  const report = (kind: string, name: string, detail = '') => {
    if (allowed.has(name)) lines.push(`golden declared ${kind}: ${name}`);
    else lines.push(`golden FAIL ${kind}: ${name}${detail}`);
    return allowed.has(name);
  };
  let ok = true;
  for (const page of diff.changed)
    ok =
      report(
        'changed',
        page.path,
        ` line ${page.line}\n  was: ${page.was.trim().slice(0, 160)}\n  now: ${page.now.trim().slice(0, 160)}`,
      ) && ok;
  for (const path of diff.added) ok = report('added', path) && ok;
  for (const file of diff.removed) ok = report('removed', file) && ok;
  return { ok, lines };
}

/** Import the DB fixture with wp-cli, the step that pins the site's content before a crawl. */
export function importDatabaseFixture(
  root: string,
  fixture: string,
  wp = 'wp',
): void {
  const run = spawnSync(wp, ['db', 'import', fixture], {
    cwd: root,
    encoding: 'utf8',
  });
  if (run.error !== undefined || run.status !== 0)
    throw new GoldenMasterError(
      `wp db import ${fixture} failed (exit ${run.status}): ${run.error?.message ?? run.stderr.trim()}`,
    );
}

/** Crawl the site at baseUrl as the repository's config describes. */
export async function crawlSite(
  root: string,
  baseUrl: string,
  wp?: string,
): Promise<Map<string, string>> {
  const config = readGoldenConfig(root);
  if (config.dbFixture !== undefined)
    importDatabaseFixture(root, config.dbFixture, wp);
  return crawlPages(baseUrl, await sitemapPaths(baseUrl, config.sitemap));
}
