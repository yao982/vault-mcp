/**
 * Prepare text for FTS5 without changing the content stored for display.
 * unicode61 does not segment a continuous Chinese run, so add explicit
 * single-character and adjacent two-character terms for Chinese retrieval.
 */
export function makeSearchText(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part) => part.replace(/\p{Script=Han}+/gu, (run) => {
      const terms = Array.from(run);
      const bigrams = terms.slice(0, -1).map((char, index) => char + terms[index + 1]);
      // Spaces at both ends prevent adjacent Latin text from being merged
      // into a different unicode61 token (for example, C中文API).
      return ` ${[...terms, ...bigrams].join(" ")} `;
    }))
    .join(" ");
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Build OR alternatives; every bigram in a long Chinese run must be present.
 * FTS5 AND tests term presence within a chunk, not term order or adjacency, so
 * this is a candidate generator rather than a Chinese phrase verifier.
 */
export function makeFtsQuery(query: string): string {
  const pieces = query.match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}_])+/gu) ?? [];
  const alternatives: string[] = [];

  for (const piece of pieces) {
    if (/^\p{Script=Han}+$/u.test(piece)) {
      const chars = Array.from(piece);
      if (chars.length === 1) {
        alternatives.push(quoteFtsTerm(chars[0]));
      } else {
        const bigrams = chars.slice(0, -1).map((char, index) => char + chars[index + 1]);
        alternatives.push(bigrams.map(quoteFtsTerm).join(" AND "));
      }
    } else {
      // Keep Latin identifiers together. FTS5's tokenizer decides their inner
      // punctuation boundaries in the same way for both indexed text and query.
      alternatives.push(quoteFtsTerm(piece));
    }
  }

  return alternatives.join(" OR ");
}
