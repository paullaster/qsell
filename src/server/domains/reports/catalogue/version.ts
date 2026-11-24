import { MEASURES } from './measures';

/**
 * The version of the whole catalogue: the latest measure version it holds. It is printed on every report
 * so a saved or exported figure can be traced to the rules that made it. It moves only when a measure's own
 * `version` moves, so it cannot drift from the definitions it describes.
 *
 * The Business Overview still reports its own `OVERVIEW_DEFINITIONS_VERSION` until the runner takes it over
 * (work package 3 of R-0); the two are not the same string and are not compared.
 */
export function catalogueVersion(): string {
  const versions = Object.values(MEASURES).map((m) => m.version);
  return versions.reduce((latest, v) => (v > latest ? v : latest), '');
}
