// Finite lexical shapes for checkpoint source. Returns categories, never matched text.
const URL_CREDENTIAL_NAME =
  /(?:password|passwd|pwd|token|secret|bearer|secret_key|aws_secret_access_key|(?:api|access|refresh|auth|client|private)[_ -]?(?:key|token|secret))/iu;
const URL_CREDENTIAL_PARAMETER = new RegExp(
  `^${URL_CREDENTIAL_NAME.source}$`,
  'iu',
);
const QUOTED_SENSITIVE_SOURCE_ASSIGNMENT =
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\b["']?\s*[:=]\s*(["'\x60])((?:\\.|(?!\1)[\s\S])*)\1/giu;
const CREDENTIAL_MARKERS = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/iu,
  /\bsk-(?:(?:test|proj|live|ant(?:-api\d+)?)-[A-Za-z0-9_-]{16,}|[A-Za-z0-9]{20,})\b/u,
  /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{16,}\b/u,
  /\bnpm_[A-Za-z0-9]{36,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bAIza[A-Za-z0-9_-]{35}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
] as const;
const URL_TEXT = /\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/giu;

export type CredentialShapeKind =
  | 'explicit credential marker'
  | 'quoted credential assignment'
  | 'URL credentials'
  | 'URL credential parameter';

export function credentialShapeKind(
  source: string,
): CredentialShapeKind | null {
  if (CREDENTIAL_MARKERS.some((pattern) => pattern.test(source)))
    return 'explicit credential marker';

  QUOTED_SENSITIVE_SOURCE_ASSIGNMENT.lastIndex = 0;
  for (const assignment of source.matchAll(
    QUOTED_SENSITIVE_SOURCE_ASSIGNMENT,
  )) {
    if ((assignment[2] ?? '').trim()) return 'quoted credential assignment';
  }

  for (const match of source.matchAll(URL_TEXT)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password) return 'URL credentials';
      for (const [name, value] of url.searchParams) {
        if (value && URL_CREDENTIAL_PARAMETER.test(name))
          return 'URL credential parameter';
      }
    } catch {
      // Malformed source text is not a URL candidate; no lookup is performed.
    }
  }
  return null;
}
