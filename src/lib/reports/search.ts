export interface Searchable {
  title: string;
  question: string;
  keywords: readonly string[];
  familyLabel: string;
}

const norm = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** How well one item matches one word: a title that starts with it is best, then any title, keyword, family, then the question. */
function wordScore(item: Searchable, word: string): number {
  const title = norm(item.title);
  if (title.startsWith(word) || title.split(' ').some((w) => w.startsWith(word))) return 100;
  if (title.includes(word)) return 60;
  if (item.keywords.some((k) => norm(k).includes(word))) return 40;
  if (norm(item.familyLabel).includes(word)) return 20;
  if (norm(item.question).includes(word)) return 10;
  return 0;
}

/**
 * The reports that match what was typed, best first. Every word typed must match something (title, keyword, family or
 * question), words may be in any order, case and accents are ignored, and an empty search returns everything in its
 * original order. Equal matches keep their original order.
 */
export function searchReports<T extends Searchable>(items: readonly T[], query: string): T[] {
  const words = norm(query)
    .split(' ')
    .filter((w) => w !== '');
  if (words.length === 0) return [...items];
  return items
    .map((item, index) => {
      const scores = words.map((w) => wordScore(item, w));
      return {
        item,
        index,
        score: scores.every((s) => s > 0) ? scores.reduce((a, b) => a + b, 0) : 0,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      const diff = b.score - a.score;
      return diff === 0 ? a.index - b.index : diff;
    })
    .map((x) => x.item);
}
