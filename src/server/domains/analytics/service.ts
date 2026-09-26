import type { DashboardAnalytics } from '@/types/index';
import { getContainer } from '@/server/di/container';
import { toReconciliationLog } from '@/server/domains/catalog/mappers';

export class AnalyticsService {
  static async getDashboardAnalytics(): Promise<DashboardAnalytics> {
    const container = getContainer();
    const orders = await container.orders.listAll();
    const products = await container.catalog.listProducts();
    const reconciliationLogs = (await container.paymentRecords.listReconciliationLogs()).map(
      toReconciliationLog,
    );

    const paidOrders = orders.filter(
      (o) => o.paymentStatus === 'paid' || o.paymentStatus === 'reconciled',
    );
    const totalRevenue = paidOrders.reduce((sum, o) => sum + o.totalAmount, 0);
    const totalOrders = orders.length;
    const averageOrderValue =
      paidOrders.length > 0 ? Math.round(totalRevenue / paidOrders.length) : 0;

    const matchedRecon = reconciliationLogs.filter((r) => !r.discrepancyFound).length;
    const reconciliationRate =
      reconciliationLogs.length > 0
        ? Number(((matchedRecon / reconciliationLogs.length) * 100).toFixed(1))
        : 100;

    const lowStockAlertsCount = products.filter((p) => {
      const available = p.stockQuantity - p.reservedQuantity;
      return available <= p.lowStockThreshold;
    }).length;

    const methodCounts: Record<string, { name: string; amount: number; count: number }> = {
      mpesa_daraja: { name: 'M-Pesa Express', amount: 0, count: 0 },
      pesapal_v3: { name: 'Pesapal v3', amount: 0, count: 0 },
      jenga_hq: { name: 'Jenga HQ', amount: 0, count: 0 },
      kcb_buni: { name: 'KCB Buni', amount: 0, count: 0 },
      card_direct: { name: 'Direct Card', amount: 0, count: 0 },
    };

    for (const ord of paidOrders) {
      if (methodCounts[ord.paymentMethod]) {
        methodCounts[ord.paymentMethod].amount += ord.totalAmount;
        methodCounts[ord.paymentMethod].count += 1;
      }
    }

    const salesByPaymentMethod = Object.entries(methodCounts).map(([provider, data]) => ({
      provider,
      name: data.name,
      amount: data.amount,
      count: data.count,
      percentage: totalRevenue > 0 ? Number(((data.amount / totalRevenue) * 100).toFixed(1)) : 0,
    }));

    const catMap: Record<string, number> = {};
    for (const row of products) {
      const price = Number(row.price ?? 0);
      const category = row.categoryLabel ?? row.categoryName;
      catMap[category] = (catMap[category] || 0) + price * Math.max(1, 10 - row.stockQuantity);
    }
    const categorySales = Object.entries(catMap).map(([category, sales]) => ({ category, sales }));

    const recentHourlySales = [
      { time: '08:00', sales: 24500, orders: 1 },
      { time: '10:00', sales: 78900, orders: 2 },
      { time: '12:00', sales: 45200, orders: 1 },
      { time: '14:00', sales: 112000, orders: 3 },
      { time: '16:00', sales: 67800, orders: 2 },
      { time: '18:00', sales: 89000, orders: 2 },
    ];

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todaySalesKes = paidOrders
      .filter((o) => new Date(o.createdAt) >= todayStart)
      .reduce((sum, o) => sum + o.totalAmount, 0);

    return {
      totalRevenue,
      totalOrders,
      averageOrderValue,
      reconciliationRate,
      activeStockSkus: products.filter((p) => p.stockQuantity - p.reservedQuantity > 0).length,
      lowStockAlertsCount,
      todaySalesKes,
      salesByPaymentMethod,
      categorySales,
      recentHourlySales,
    };
  }

  static async getUserAnalytics(userId: string) {
    const userOrders = await getContainer().orders.listByUserId(userId);
    const spent = userOrders
      .filter((o) => o.paymentStatus === 'paid' || o.paymentStatus === 'reconciled')
      .reduce((s, o) => s + o.totalAmount, 0);
    return {
      orderCount: userOrders.length,
      lifetimeValue: spent,
      preferredPaymentMethod: userOrders[0]?.paymentMethod || 'mpesa_daraja',
      lastOrderAt: userOrders[0]?.createdAt || null,
    };
  }
}
