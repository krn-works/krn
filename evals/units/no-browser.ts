// Third-party test code may open a URL on the host desktop: gold grading of a
// vibez unit ran `go test`, whose TUI calls openurl.Open, and Chrome opened
// ko-fi.com three times overnight (t-nsk5wca). Every screening command and arm
// session therefore finds stub openers first on PATH, and no display or
// session bus to reach a real one through.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The programs a library calls to open a URL; each stub logs its arguments and exits 0. */
export const OPENERS = [
  'xdg-open',
  'open',
  'sensible-browser',
  'x-www-browser',
  'www-browser',
  'gio',
  'kde-open',
  'gnome-open',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'firefox',
] as const;

/** Where the stubs live under `dir` and where they log the URLs they were handed. */
export function openerPaths(dir: string): { bin: string; log: string } {
  return { bin: join(dir, 'bin'), log: join(dir, 'opened.log') };
}

/**
 * Writes the stub openers under `dir` and answers `env` with them first on
 * PATH, BROWSER pointed at the stub xdg-open, no DISPLAY or WAYLAND_DISPLAY,
 * and the session bus at a path that does not exist.
 */
export function withoutBrowser(
  env: NodeJS.ProcessEnv,
  dir: string,
): NodeJS.ProcessEnv {
  const { bin, log } = openerPaths(dir);
  mkdirSync(bin, { recursive: true });
  for (const name of OPENERS) {
    const stub = join(bin, name);
    writeFileSync(
      stub,
      `#!/bin/sh\nprintf '%s %s\\n' ${name} "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
    );
    chmodSync(stub, 0o755);
  }
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.DISPLAY;
  delete out.WAYLAND_DISPLAY;
  out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(dir, 'no-bus')}`;
  out.BROWSER = join(bin, 'xdg-open');
  out.PATH = env.PATH ? `${bin}${delimiter}${env.PATH}` : bin;
  return out;
}
