import postgres from 'postgres';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {}, // silence NOTICE messages
});

// Helper to cast complex objects (Stripe/Google/external APIs) for sql() inserts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sqlv = (obj: Record<string, unknown>): any => obj;
