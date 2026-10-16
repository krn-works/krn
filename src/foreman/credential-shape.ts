// Finite lexical shapes for checkpoint source. Returns categories, never matched text.
const URL_CREDENTIAL_NAME =
  /(?:password|passwd|pwd|token|secret|bearer|secret_key|aws_secret_access_key|(?:api|access|refresh|auth|client|private)[_ -]?(?:key|token|secret))/iu;
const URL_CREDENTIAL_PARAMETER = new RegExp(
  `^${URL_CREDENTIAL_NAME.source}$`,
  'iu',
);
const CREDENTIAL_MARKERS = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/iu,
  /\bsk-(?:(?:test|proj|live|ant(?:-api\d+)?)-[A-Za-z0-9_-]{16,}|[A-Za-z0-9]{20,})\b/u,
  /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{16,}\b/u,
  /\bnpm_[A-Za-z0-9]{36,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bAIza[A-Za-z0-9_-]{35}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
] as const;
const ASCII_WORD_CHARACTER = /[A-Za-z0-9_]/u;
const JWT_CHARACTER = /[A-Za-z0-9_-]/u;
const URI_WORD_CHARACTER = /\w/iu;
const URI_SCHEME_FIRST = /[a-z]/iu;
const URI_SCHEME_CHARACTER = /[a-z\d+.-]/iu;
const URI_TEXT_TERMINATOR = /[\s<>"']/u;

export type CredentialShapeKind =
  | 'explicit credential marker'
  | 'URL credentials'
  | 'URL credential parameter';

function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function hasJwtMarker(source: string): boolean {
  if (!source.includes('eyJ')) return false;

  const length = source.length;
  const runEnd = new Uint32Array(length + 1);
  runEnd[length] = length;
  for (let index = length - 1; index >= 0; index--) {
    const character = source[index] ?? '';
    if (JWT_CHARACTER.test(character)) {
      runEnd[index] =
        index + 1 < length && JWT_CHARACTER.test(source[index + 1] ?? '')
          ? (runEnd[index + 1] ?? index + 1)
          : index + 1;
    } else {
      runEnd[index] = index;
    }
  }

  const nextWordBoundary = new Uint32Array(length + 2);
  nextWordBoundary[length + 1] = length + 1;
  for (let end = length; end >= 0; end--) {
    const boundary =
      end > 0 &&
      isAsciiWordCode(source.charCodeAt(end - 1)) &&
      (end === length || !isAsciiWordCode(source.charCodeAt(end)));
    nextWordBoundary[end] = boundary
      ? end
      : (nextWordBoundary[end + 1] ?? length + 1);
  }

  for (let index = 0; index + 2 < length; index++) {
    if (
      source[index] !== 'e' ||
      source[index + 1] !== 'y' ||
      source[index + 2] !== 'J' ||
      (index > 0 && isAsciiWordCode(source.charCodeAt(index - 1)))
    )
      continue;

    const firstEnd = runEnd[index] ?? index;
    if (firstEnd - index < 11 || source[firstEnd] !== '.') continue;
    const secondStart = firstEnd + 1;
    const secondEnd = runEnd[secondStart] ?? secondStart;
    if (secondEnd - secondStart < 8 || source[secondEnd] !== '.') continue;
    const thirdStart = secondEnd + 1;
    const thirdEnd = runEnd[thirdStart] ?? thirdStart;
    if (thirdEnd - thirdStart < 8) continue;
    const matchEnd = nextWordBoundary[thirdStart + 8] ?? length + 1;
    if (matchEnd <= thirdEnd) return true;
  }
  return false;
}

function hasExplicitCredentialMarker(source: string): boolean {
  return (
    CREDENTIAL_MARKERS.some((pattern) => pattern.test(source)) ||
    hasJwtMarker(source)
  );
}

function hasUrlCredential(source: string): CredentialShapeKind | null {
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? '';
    if (
      URI_SCHEME_FIRST.test(character) &&
      (index === 0 || !URI_WORD_CHARACTER.test(source[index - 1] ?? ''))
    ) {
      let schemeEnd = index + 1;
      while (
        schemeEnd < source.length &&
        URI_SCHEME_CHARACTER.test(source[schemeEnd] ?? '')
      )
        schemeEnd++;

      if (
        source.startsWith('://', schemeEnd) &&
        schemeEnd + 3 < source.length &&
        !URI_TEXT_TERMINATOR.test(source[schemeEnd + 3] ?? '')
      ) {
        let urlEnd = schemeEnd + 3;
        while (
          urlEnd < source.length &&
          !URI_TEXT_TERMINATOR.test(source[urlEnd] ?? '')
        )
          urlEnd++;
        const text = source.slice(index, urlEnd);
        try {
          const url = new URL(text);
          if (url.username || url.password) return 'URL credentials';
          for (const [name, value] of url.searchParams) {
            if (value && URL_CREDENTIAL_PARAMETER.test(name))
              return 'URL credential parameter';
          }
        } catch {
          // Malformed source text is not a URL candidate; no lookup is performed.
        }
        index = urlEnd;
        continue;
      }
      index = schemeEnd;
      continue;
    }
    index++;
  }
  return null;
}

export function credentialShapeKind(
  source: string,
): CredentialShapeKind | null {
  if (hasExplicitCredentialMarker(source)) return 'explicit credential marker';
  return hasUrlCredential(source);
}
