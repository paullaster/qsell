import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseClamdReply, scanWithClamd, scannerFromEnv } from './virus-scan';

describe('virus scan answers', () => {
  it('reads clean, infected and broken replies', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ kind: 'clean' });
    expect(parseClamdReply('stream: Eicar-Test-Signature FOUND')).toEqual({ kind: 'infected', name: 'Eicar-Test-Signature' });
    expect(parseClamdReply('INSTREAM size limit exceeded. ERROR').kind).toBe('unavailable');
    expect(parseClamdReply('').kind).toBe('unavailable');
  });
  it('is off unless a host is set, and sanitises the rest', () => {
    expect(scannerFromEnv({})).toBeNull();
    expect(scannerFromEnv({ CLAMD_HOST: 'clam', CLAMD_PORT: 'abc', CLAMD_FAIL_OPEN: '1' })).toEqual({ host: 'clam', port: 3310, timeoutMs: 15_000, failOpen: true });
  });
});

/** A stand-in for clamd: reads the INSTREAM frames and answers FOUND when the bytes contain the EICAR marker. */
function fakeClamd(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let received = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.subarray(received.length - 4).equals(Buffer.alloc(4))) {
          socket.end(received.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: typeof address === 'object' && address !== null ? address.port : 0, close: () => server.close() });
    });
  });
}

describe('scanning through a clamd socket', () => {
  it('passes a clean file, stops an infected one and reports an unreachable scanner as unavailable', async () => {
    const clam = await fakeClamd();
    try {
      const target = { host: '127.0.0.1', port: clam.port, timeoutMs: 3000 };
      expect(await scanWithClamd(Buffer.from('%PDF-1.4 hello'), target)).toEqual({ kind: 'clean' });
      expect(await scanWithClamd(Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')]), target)).toEqual({ kind: 'infected', name: 'Eicar-Test-Signature' });
      expect(await scanWithClamd(Buffer.alloc(200_000, 1), target)).toEqual({ kind: 'clean' });
    } finally {
      clam.close();
    }
    expect((await scanWithClamd(Buffer.from('x'), { host: '127.0.0.1', port: 1, timeoutMs: 1000 })).kind).toBe('unavailable');
  });
});
