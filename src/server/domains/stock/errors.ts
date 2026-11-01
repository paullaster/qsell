/** A stock rule that stopped something, with words for the person. The code is for tests and callers. */
export class StockError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'StockError';
  }
}
