/**
 * Background work the payment engine hands to the job queue. Each job is keyed, so asking for the
 * same thing twice (a callback and a timer both wanting a payment checked) runs it once, and a
 * request for sooner replaces a request for later.
 */
export interface PaymentJobs {
  /** Check a gateway payment attempt with the platform, now or in `inSeconds`. */
  verifyAttempt(attemptId: string, inSeconds?: number, mode?: 'replace' | 'preserve_run_at'): Promise<void>;
  /** Check money that arrived straight into an account (a paybill or till payment). */
  verifyTransaction(transactionId: string, inSeconds?: number): Promise<void>;
  /** Read and act on a callback that was written down. */
  processEvent(eventId: string): Promise<void>;
  /** Send an operation to the platform (or send it again). */
  sendOperation(operationId: string, inSeconds?: number): Promise<void>;
}

export class GraphileJobs implements PaymentJobs {
  private async add(task: string, payload: Record<string, unknown>, key: string, inSeconds: number, maxAttempts: number, mode: 'replace' | 'preserve_run_at' = 'replace') {
    const { getWorkerUtils } = await import('@/server/queue/worker');
    const utils = await getWorkerUtils();
    await utils.addJob(task, payload, {
      queueName: 'payment-engine',
      jobKey: key,
      jobKeyMode: mode,
      runAt: new Date(Date.now() + Math.max(0, inSeconds) * 1000),
      maxAttempts,
    });
  }

  verifyAttempt(attemptId: string, inSeconds = 0, mode: 'replace' | 'preserve_run_at' = 'replace') {
    return this.add('provider-verify-attempt', { attemptId }, `verify-attempt:${attemptId}`, inSeconds, 10, mode);
  }

  verifyTransaction(transactionId: string, inSeconds = 0) {
    return this.add('provider-verify-transaction', { transactionId }, `verify-tx:${transactionId}`, inSeconds, 10);
  }

  processEvent(eventId: string) {
    return this.add('provider-process-event', { eventId }, `event:${eventId}`, 0, 10);
  }

  sendOperation(operationId: string, inSeconds = 0) {
    return this.add('provider-send-operation', { operationId }, `op:${operationId}`, inSeconds, 10);
  }
}
