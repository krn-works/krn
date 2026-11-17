// GitHub remote URLs: the one parser every area uses.
/**
 * The owner/name a GitHub remote URL names (https or scp-style ssh), else undefined.
 */
export function repositoryOfRemote(url: string): string | undefined {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?\/?$/u.exec(
      url.trim(),
    );
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : undefined;
}
