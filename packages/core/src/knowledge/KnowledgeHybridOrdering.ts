export interface HybridLexicalEntry {
  key: string;
  semanticScore: number;
  /** Member of the near-tie cluster around an ambiguous lexical leader. */
  inCluster: boolean;
}

export interface HybridExpansionEntry {
  key: string;
  semanticScore: number;
}

export interface HybridOrderingInput {
  /** Lexical candidates in their deterministic order; index 0 is the lexical leader. */
  lexical: readonly HybridLexicalEntry[];
  expansion: readonly HybridExpansionEntry[];
  /** Confidence computed before any semantic step; `none` when there is no lexical candidate. */
  confidence: 'clear' | 'ambiguous' | 'none';
  /** No span-backed lexical candidate covers every distinct query term. */
  weakPool: boolean;
}

export interface HybridOrderedEntry {
  key: string;
  expanded: boolean;
}

export interface HybridOrdering {
  order: HybridOrderedEntry[];
  /** True when an expansion candidate leads the result. */
  rescued: boolean;
}

function bySemanticScore(left: HybridExpansionEntry, right: HybridExpansionEntry): number {
  return right.semanticScore - left.semanticScore || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

/**
 * Ordered comparator for hybrid ranking, not a score sum. A clear lexical order is invariant; semantic score only
 * reorders an ambiguous near-tie cluster in place and orders expansion candidates, which lead only when there is no
 * lexical candidate or when a weak, ambiguous lexical pool is outscored by them.
 */
export function orderHybridCandidates(input: HybridOrderingInput): HybridOrdering {
  const expansion = [...input.expansion].sort(bySemanticScore);
  let lexical = input.lexical.map((entry): HybridOrderedEntry & { semanticScore: number; inCluster: boolean } => ({
    key: entry.key,
    expanded: false,
    semanticScore: entry.semanticScore,
    inCluster: entry.inCluster,
  }));
  let leaders: HybridExpansionEntry[] = [];
  let trailing = expansion;

  if (input.lexical.length === 0) {
    leaders = expansion;
    trailing = [];
  } else if (input.confidence === 'ambiguous') {
    const slots = lexical.map((entry, index) => (entry.inCluster ? index : -1)).filter((index) => index >= 0);
    const reordered = slots
      .map((index) => lexical[index])
      .sort((left, right) => right.semanticScore - left.semanticScore);
    const next = [...lexical];
    slots.forEach((slot, position) => {
      next[slot] = reordered[position];
    });
    lexical = next;
    if (input.weakPool) {
      const bestCluster = Math.max(...slots.map((slot) => input.lexical[slot].semanticScore));
      leaders = expansion.filter((entry) => entry.semanticScore > bestCluster);
      trailing = expansion.filter((entry) => entry.semanticScore <= bestCluster);
    }
  }

  const order: HybridOrderedEntry[] = [
    ...leaders.map((entry) => ({ key: entry.key, expanded: true })),
    ...lexical.map(({ key, expanded }) => ({ key, expanded })),
    ...trailing.map((entry) => ({ key: entry.key, expanded: true })),
  ];
  return { order, rescued: order.length > 0 && order[0].expanded };
}
