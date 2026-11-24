'use client';

import { formatLocalDate } from '@/lib/reports/format';
import { LineArea } from '@/components/reports/charts/LineArea';

interface Point {
  date: string;
  sales: number;
  orders: number;
  previousDate: string;
  previousSales: number;
}

/**
 * Daily sales as a line with the comparison period drawn dashed over it. Hover, touch or the arrow keys read out any day,
 * and every day is also available as a table. Drawn by the shared report chart kit.
 */
export function SalesTrend({
  trend,
  currency,
  compareLabel,
}: {
  trend: Point[];
  currency: string;
  compareLabel: string;
}) {
  const hasPrevious = trend.some((d) => d.previousSales > 0);
  return (
    <LineArea
      categories={trend.map((d) => formatLocalDate(d.date).replace(/ \d{4}$/, ''))}
      series={[
        { key: 'sales', label: 'Sales per day', values: trend.map((d) => d.sales) },
        ...(hasPrevious
          ? [
              {
                key: 'previous',
                label: compareLabel,
                values: trend.map((d) => d.previousSales),
                dashed: true,
                slot: 7,
              },
            ]
          : []),
      ]}
      unit={{ kind: 'money', currency }}
      ariaLabel="Daily sales"
      categoryLabel="Day"
    />
  );
}
