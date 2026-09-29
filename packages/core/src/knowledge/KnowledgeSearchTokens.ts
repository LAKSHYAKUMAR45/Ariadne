export const SEARCH_TOKEN_LENGTH = 3;
/** Longest gram prefix used to narrow a needle; a subset of a needle's grams still yields a lossless superset. */
export const MAX_NEEDLE_GRAMS = 12;

/** Distinct lowercase character trigrams. Any substring match of length >= 3 implies all of its trigrams are present. */
export function trigramsOf(foldedText: string): string[] {
  const characters = Array.from(foldedText);
  const grams = new Set<string>();
  for (let start = 0; start + SEARCH_TOKEN_LENGTH <= characters.length; start += 1) {
    grams.add(characters.slice(start, start + SEARCH_TOKEN_LENGTH).join(''));
  }
  return [...grams];
}

export function foldSearchText(value: string): string {
  return value.toLocaleLowerCase();
}

export function needleNarrowingGrams(foldedNeedle: string): string[] {
  return trigramsOf(foldedNeedle).slice(0, MAX_NEEDLE_GRAMS);
}

/** Identifier-aware distinct tokens shared by lexical scoring and the local semantic model. */
export function searchTokens(value: string): string[] {
  const tokens = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return [
    ...new Set(
      tokens.flatMap((token) => (token === 'usecase' ? [token, 'use', 'case'] : [token])),
    ),
  ];
}
