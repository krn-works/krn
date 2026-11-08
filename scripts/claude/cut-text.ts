// Longest code-point prefix of `text` whose measure stays within `limit`.
// Cutting on code points keeps an astral character (an emoji) whole, so a cut
// never leaves a lone surrogate that provider JSON parsers reject. `measure`
// defaults to UTF-16 length; pass a byte or envelope size for other budgets.
// It must grow with the prefix and accept the empty string.
export function cutText(
  text: string,
  limit: number,
  measure: (value: string) => number = (value) => value.length,
): string {
  if (measure(text) <= limit) return text;
  const points = Array.from(text);
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(points.slice(0, middle).join('')) <= limit) low = middle;
    else high = middle - 1;
  }
  return points.slice(0, low).join('');
}
