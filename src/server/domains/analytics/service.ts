import { db } from '@/server/db/store';
import type { DashboardAnalytics } from '@/types/index';

export class AnalyticsService {
  static getDashboardAnalytics(): DashboardAnalytics {
    const orders = Array.from(db.orders.values());
    const products = Array.from(db.products.values());
    const reconciliationLogs = db.reconciliationLogs;

    const paidOrders = orders.filter(
      (o) => o.paymentStatus === 'paid' || o.paymentStatus === 'reconciled'
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
    for (const prod of products) {
      catMap[prod.category] =
        (catMap[prod.category] || 0) + prod.price * Math.max(1, 10 - prod.stockQuantity);
    }
    const categorySales = Object.entries(catMap).map(([category, sales]) => ({ category, sales }));

    const recentHourlySales = [
      { time: '08:00', sales: 24500, orders: 1 },
      { time: '10:00', sales: 78900, orders: 2 },
      { time: '12:00', sales: 142000, orders: 4 },
      { time: '14:00', sales: 98000, orders: 2 },
      { time: '16:00', sales: 118240, orders: 3 },
      { time: '18:00', sales: 61980, orders: 2 },
    ];

    return {
      totalRevenue,
      totalOrders,
      averageOrderValue,
      reconciliationRate,
      activeStockSkus: products.length,
      lowStockAlertsCount,
      todaySalesKes: totalRevenue,
      salesByPaymentMethod,
      recentHourlySales,
      categorySales,
    };
  }

  static getUserAnalytics(userId: string) {
    const userOrders = Array.from(db.orders.values()).filter((o) => o.userId === userId);
    const totalSpent = userOrders
      .filter((o) => o.paymentStatus === 'paid' || o.paymentStatus === 'reconciled')
      .reduce((sum, o) => sum + o.totalAmount, 0);

    return {
      userId,
      ordersCount: userOrders.length,
      totalSpent,
      preferredPaymentMethod: userOrders[0]?.paymentMethod || 'mpesa_daraja',
      recentOrders: userOrders.slice(0, 5),
    };
  }
}
