import { orders } from '@/server/db/drizzle/schema';
import { sql } from 'drizzle-orm';

export const WEB_SHOP_ORDER = sql`(
  ${orders.salesModule} = 'ecommerce'
  OR EXISTS (
    SELECT 1 FROM checkout_attempts ca
    WHERE ca.order_id = ${orders.id} AND ca.channel = 'ecommerce'
  )
  OR EXISTS (
    SELECT 1 FROM order_stage_events ose
    WHERE ose.order_id = ${orders.id} AND ose.sequence = 1 AND ose.source = 'shop'
  )
)`;
