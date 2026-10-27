import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL ?? 'postgres://qsell:qsell@127.0.0.1:5432/qsell';

const globalForDb = globalThis as unknown as {
  pgClient?: ReturnType<typeof postgres>;
  drizzleDb?: ReturnType<typeof drizzle<typeof schema>>;
  kernelClient?: ReturnType<typeof postgres>;
  kernelDb?: ReturnType<typeof drizzle<typeof schema>>;
};

function createClient() {
  return postgres(connectionString, {
    max: 10,
    // A shop that is quiet for a minute must not pay for new connections (each one also fetches the type list) on its next visit.
    idle_timeout: 300,
    connect_timeout: 10,
  });
}

/**
 * A small pool of its own for kernel bookkeeping that runs WHILE a caller holds a connection in
 * a transaction (number-block reservation, first-use setup). If that work borrowed from the main
 * pool, enough waiting transactions could hold every connection and deadlock; with its own pool
 * it can always make progress.
 */
function createKernelClient() {
  return postgres(connectionString, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

const client = globalForDb.pgClient ?? createClient();
const kernelClient = globalForDb.kernelClient ?? createKernelClient();
export const drizzleDb = globalForDb.drizzleDb ?? drizzle(client, { schema });
export const kernelDb = globalForDb.kernelDb ?? drizzle(kernelClient, { schema });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pgClient = client;
  globalForDb.drizzleDb = drizzleDb;
  globalForDb.kernelClient = kernelClient;
  globalForDb.kernelDb = kernelDb;
}

export type DrizzleDb = typeof drizzleDb;
