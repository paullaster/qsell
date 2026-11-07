import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import { DeliveryBilling } from '@/server/domains/delivery/billing';
import { DeliveryMethods } from '@/server/domains/delivery/methods';
import { OrderCollections } from '@/server/domains/delivery/collection';
import { DeliveryDocuments } from '@/server/domains/delivery/documents';
import { DeliveryMessages } from '@/server/domains/delivery/messages';
import { TrackingLinks } from '@/server/domains/delivery/tracking-links';
import { TrackedOrders } from '@/server/domains/delivery/tracked-order';
import type { EmailPort } from '@/server/ports/communications';
import { StockReissue } from '@/server/domains/delivery/reissue';
import { DeliveryRiders } from '@/server/domains/delivery/riders';
import { DoorPayments } from '@/server/domains/delivery/door-payments';
import { DeliveryCosts } from '@/server/domains/delivery/costs';
import { DoorWork } from '@/server/domains/delivery/door';
import type { CustomerMasterService } from '@/server/domains/customers/master-service';
import { RiderRuns } from '@/server/domains/delivery/rider-runs';
import { DeliveryRuns } from '@/server/domains/delivery/runs';
import type { UsersAdminRepository } from '@/server/domains/users/repository';
import { CourierShipments } from '@/server/domains/delivery/shipments';
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
import type { StockReservations } from '@/server/domains/stock/reservations';

/** Composes delivery collaborators outside the main container to keep initialization dependencies in one ordered scope. */
export function createDeliveryServices(input: {
  db: DrizzleDb;
  decisionLog: DecisionLog;
  geo: GeoService;
  companySettings: CompanySettingsRepository;
  numbering: NumberSeriesService;
  stockReservations: StockReservations;
  email: EmailPort;
  usersAdmin: Pick<UsersAdminRepository, 'createUser' | 'resetPassword'>;
  customers: Pick<CustomerMasterService, 'applyOrderPayment'>;
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
  const trackingLinks = new TrackingLinks(input.db, input.decisionLog);
  const deliveryMessages = new DeliveryMessages(input.db, input.email, input.companySettings, trackingLinks);
  const deliveryDocuments = new DeliveryDocuments(input.db, input.decisionLog, input.numbering, input.stockReservations, deliveryMessages);
  const deliveryRiders = new DeliveryRiders(input.db, input.decisionLog, input.usersAdmin);
  const riderRuns = new RiderRuns(input.db);
  const deliveryCosts = new DeliveryCosts(input.db, input.decisionLog);
  const deliveryRuns = new DeliveryRuns(input.db, input.decisionLog, input.numbering, deliveryDocuments, deliveryRiders, deliveryCosts);
  const doorPayments = new DoorPayments(input.db, input.decisionLog, deliveryDocuments, input.customers);
  const doorWork = new DoorWork(input.db, deliveryDocuments, deliveryRuns, input.decisionLog, doorPayments, deliveryCosts);
  const courierShipments = new CourierShipments(input.db, deliveryDocuments);
  const trackedOrders = new TrackedOrders(input.db, input.companySettings, deliveryDocuments, orderCollections);
  const stockReissue = new StockReissue(input.db, input.decisionLog, input.stockReservations);
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
    trackingLinks,
    deliveryMessages,
    trackedOrders,
    stockReissue,
    deliveryRuns,
    deliveryRiders,
    riderRuns,
    doorWork,
    doorPayments,
    deliveryCosts,
    courierShipments,
    deliveryBilling,
  };
}
