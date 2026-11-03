import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import { DeliveryBilling } from '@/server/domains/delivery/billing';
import { DeliveryMethods } from '@/server/domains/delivery/methods';
import { OrderCollections } from '@/server/domains/delivery/collection';
import { DeliveryDocuments } from '@/server/domains/delivery/documents';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { OrderDeliveries } from '@/server/domains/delivery/order-delivery';
import { DeliveryPlans } from '@/server/domains/delivery/plan';
import { DeliveryQuotes } from '@/server/domains/delivery/quote';
import { ChargePolicies } from '@/server/domains/delivery/charge-policies';
import { DeliveryZones } from '@/server/domains/delivery/zones';
import type { GeoService } from '@/server/domains/geo/service';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { StockAvailability } from '@/server/domains/stock/availability';
import { StockSettingsService } from '@/server/domains/stock/settings';

/** Composes delivery collaborators outside the main container to keep initialization dependencies in one ordered scope. */
export function createDeliveryServices(input: {
  db: DrizzleDb;
  decisionLog: DecisionLog;
  geo: GeoService;
  companySettings: CompanySettingsRepository;
  numbering: NumberSeriesService;
}) {
  const stockAvailability = new StockAvailability(input.db);
  const stockSettings = new StockSettingsService(input.db, input.companySettings);
  const deliveryZones = new DeliveryZones(input.db, input.decisionLog);
  const chargePolicies = new ChargePolicies(input.db, input.decisionLog);
  const deliveryMethods = new DeliveryMethods(input.db, input.decisionLog);
  const deliveryQuotes = new DeliveryQuotes(input.db, chargePolicies, deliveryZones, input.geo);
  const deliveryPlans = new DeliveryPlans(
    input.db,
    input.geo,
    deliveryMethods,
    stockAvailability,
    stockSettings,
    deliveryQuotes,
  );
  const orderDeliveries = new OrderDeliveries(input.db, input.decisionLog);
  const orderCollections = new OrderCollections(input.db, input.decisionLog);
  const deliveryDocuments = new DeliveryDocuments(input.db, input.decisionLog, input.numbering);
  const deliveryBilling = new DeliveryBilling(input.db, input.decisionLog);

  return {
    stockAvailability,
    stockSettings,
    deliveryZones,
    chargePolicies,
    deliveryMethods,
    deliveryQuotes,
    deliveryPlans,
    orderDeliveries,
    orderCollections,
    deliveryDocuments,
    deliveryBilling,
  };
}
