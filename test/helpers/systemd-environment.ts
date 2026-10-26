import { join } from 'node:path';
import { userManagerEnvironment } from '../../src/hosts/systemd-scope.ts';

export function systemdEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = userManagerEnvironment(source);
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime)
    env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${join(runtime, 'bus')}`;
  return env;
}
