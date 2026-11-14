export function commandErrorExitCode(error: unknown): number {
  if (
    ((typeof error === 'object' && error !== null) ||
      typeof error === 'function') &&
    'exitCode' in error &&
    typeof error.exitCode === 'number'
  )
    return error.exitCode;

  if (
    error instanceof Error &&
    error.constructor === Error &&
    !('code' in error) &&
    !('syscall' in error)
  )
    return 64;

  return 70;
}
