import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { describe, expect, it } from 'vitest';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import type { GeoService } from '@/server/domains/geo/service';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { createDeliveryServices } from './delivery-wiring';
import type { StockReservations } from '@/server/domains/stock/reservations';
import type { EmailPort } from '@/server/ports/communications';

describe('createDeliveryServices', () => {
  it('constructs the quote and plan graph with initialized dependencies', () => {
    const services = createDeliveryServices({
      db: {} as DrizzleDb,
      decisionLog: {} as DecisionLog,
      numbering: {} as NumberSeriesService,
      stockReservations: {} as StockReservations,
      email: {} as EmailPort,
      geo: {} as GeoService,
      companySettings: {} as CompanySettingsRepository,
    });

    expect(services.deliveryQuotes).toHaveProperty('policies', services.chargePolicies);
    expect(services.deliveryQuotes).toHaveProperty('zones', services.deliveryZones);
    expect(services.deliveryPlans).toHaveProperty('methods', services.deliveryMethods);
    expect(services.deliveryPlans).toHaveProperty('quotes', services.deliveryQuotes);
    expect(services.deliveryPlans).toHaveProperty('availability', services.stockAvailability);
    expect(services.deliveryPlans).toHaveProperty('stockSettings', services.stockSettings);
  });
});
