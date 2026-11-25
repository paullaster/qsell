import { sql } from 'drizzle-orm';
import { orderItems } from '@/server/db/drizzle/schema';

/**
 * The lines of an order in the order they were rung up: by their line number. Orders from before line numbers were kept have none, so
 * they follow in the order they always came in (by id), and nothing that exists changes. Use it wherever lines are shown or signed.
 */
export const lineOrder = [sql`${orderItems.lineNo} ASC NULLS LAST`, sql`${orderItems.id}`] as const;
