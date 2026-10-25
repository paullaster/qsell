import { connect } from 'node:net';

/** What a scanner said about a file. `unavailable` means it could not be asked, which is not the same as clean. */
export type ScanVerdict = { kind: 'clean' } | { kind: 'infected'; name: string } | { kind: 'unavailable'; reason: string };

/** Reads a clamd answer such as `stream: OK`, `stream: Eicar-Test-Signature FOUND` or `INSTREAM size limit exceeded. ERROR`. */
export function parseClamdReply(reply: string): ScanVerdict {
  const text = reply.replace(/\0/g, '').trim();
  if (/\bOK$/.test(text)) return { kind: 'clean' };
  const found = /^[^:]*:\s*(.+?)\s+FOUND$/.exec(text);
  if (found !== null) return { kind: 'infected', name: found[1] ?? 'unknown' };
  return { kind: 'unavailable', reason: text === '' ? 'no answer' : text.slice(0, 200) };
}

/** Where to scan, from the environment; null when no scanner is configured. */
export function scannerFromEnv(env: Record<string, string | undefined>): { host: string; port: number; timeoutMs: number; failOpen: boolean } | null {
  const host = env.CLAMD_HOST?.trim() ?? '';
  if (host === '') return null;
  const port = Number(env.CLAMD_PORT ?? '3310');
  const timeout = Number(env.CLAMD_TIMEOUT_MS ?? '15000');
  return { host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3310, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000, failOpen: env.CLAMD_FAIL_OPEN === '1' };
}

/** Streams the file to a ClamAV daemon (the INSTREAM command) and returns its verdict. */
export function scanWithClamd(data: Buffer, target: { host: string; port: number; timeoutMs: number }): Promise<ScanVerdict> {
  return new Promise((resolve) => {
    let reply = '';
    let done = false;
    const socket = connect({ host: target.host, port: target.port });
    const finish = (verdict: ScanVerdict) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(verdict);
    };
    socket.setTimeout(target.timeoutMs, () => finish({ kind: 'unavailable', reason: 'the scanner took too long' }));
    socket.on('error', (error) => finish({ kind: 'unavailable', reason: error.message }));
    socket.on('data', (chunk) => {
      reply += chunk.toString('latin1');
    });
    socket.on('end', () => finish(parseClamdReply(reply)));
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const CHUNK = 64 * 1024;
      for (let at = 0; at < data.length; at += CHUNK) {
        const part = data.subarray(at, at + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(part.length);
        socket.write(size);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
