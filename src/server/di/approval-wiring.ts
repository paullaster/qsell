import { drizzleDb } from '@/server/db/drizzle/client';
import type { ApprovalEngine } from '@/server/kernel/approvals/engine';
import type { ParkedActions } from '@/server/kernel/approvals/parked-actions';
import { orderApprovalHandler } from '@/server/domains/orders/approval';
import {
  discountRuleApprovalHandler,
  rebateSettlementApprovalHandler,
  priceChangeExecutors,
  priceListApprovalHandler,
} from '@/server/domains/pricing/approval';
import { quoteApprovalHandler } from '@/server/domains/quotes/approval';
import { refundApprovalHandler } from '@/server/domains/finance/refund-approval';
import type { CreditNoteReason } from '@/server/domains/credit-notes/reasons';
import type { StockOp } from '@/server/domains/inventory/service';

/**
 * Tells the approval engine how each module's documents are held, released, rejected and
 * reopened. Modules are imported when an approval is acted on, not here, so the container can be
 * built without loading every domain.
 */
export function registerApprovalHandlers(engine: ApprovalEngine, gate: ParkedActions): void {
  engine.registerDocument('sales_order', orderApprovalHandler(drizzleDb));
  engine.registerDocument('sales_quote', quoteApprovalHandler(drizzleDb));
  engine.registerDocument('price_list', priceListApprovalHandler(drizzleDb));
  engine.registerDocument('discount_rule', discountRuleApprovalHandler(drizzleDb));
  engine.registerDocument('rebate_settlement', rebateSettlementApprovalHandler(drizzleDb));
  engine.registerDocument('refund', refundApprovalHandler(drizzleDb));

  gate.attach('price_list_change', priceChangeExecutors());

  gate.attach('credit_note', {
    order_credit_note: {
      async execute(tx, row) {
        const { getContainer } = await import('@/server/di/container');
        const p = row.payload as {
          orderId: string;
          lines: { productId: string; quantity: number }[];
          reason: { code: CreditNoteReason; note?: string };
          restock?: boolean;
        };
        // Issued in the approver's transaction, on behalf of the person who asked for it.
        const cn = await getContainer().creditNotes.issueForOrder(
          {
            orderId: p.orderId,
            lines: p.lines,
            reason: p.reason,
            issuedBy: row.requestedBy,
            restock: p.restock,
          },
          tx,
        );
        return { creditNoteId: cn.id, creditNoteNo: cn.creditNoteNo };
      },
    },
  });

  gate.attach('stock_adjustment', {
    stock_operation: {
      async execute(tx, row) {
        const { InventoryDomainService } = await import('@/server/domains/inventory/service');
        const result = await InventoryDomainService.applyOp(
          tx,
          row.companyId,
          row.payload as unknown as StockOp,
        );
        return { ...result };
      },
    },
  });
}
