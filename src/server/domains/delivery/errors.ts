export type DeliveryErrorCode = 'NOT_FOUND' | 'BAD_INPUT' | 'DUPLICATE' | 'CONFLICT' | 'NOT_ALLOWED';

/** A refusal the person should read, in words they can act on. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    public readonly code: DeliveryErrorCode,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}
