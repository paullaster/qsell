import { randomUUID } from 'node:crypto';
import { emptyToNull, has, nth, orElse, required } from '@/lib/values';
import { afterCursor, matching, pageOf, PAGE_SIZE, searchText, type PageInput } from '@/server/domains/settings/paging';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  customerAddresses,
  customerDetailedEntries,
  customerLedgerEntries,
  customerProfiles,
  customers,
  orders,
  type CustomerAddressRow,
  type CustomerLedgerEntryRow,
  type CustomerProfileRow,
  type CustomerRow,
  type DimensionCodesProjection,
} from '@/server/db/drizzle/schema';
import { shownPaymentReference } from '@/lib/paymentReference';
import { getContainer } from '@/server/di/container';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { emptyDimensionCodes } from '@/server/domains/dimensions/projection';
import type { DimensionSetService } from '@/server/domains/dimensions/set-service';
import type { TransactionLedgerService } from '@/server/domains/transactions/ledger-service';

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export type CustomerAccountType = 'cash' | 'credit';
export type CustomerBlock = 'none' | 'ship' | 'invoice' | 'all';

export interface CustomerAddressInput {
  label: string;
  recipientName: string;
  recipientPhone: string;
  street: string;
  city: string;
  countyOrState: string;
  postalCode?: string | null;
  country: string;
  isDefault?: boolean;
}

function num(value: string | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function money(value: number): string {
  return value.toFixed(2);
}

export class CustomerMasterService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly dimensionSets: DimensionSetService,
    private readonly ledger: TransactionLedgerService,
  ) {}

  /** One profile of this company, or null. */
  async getProfile(companyId: string, id: string): Promise<CustomerProfileRow | null> {
    const [row] = await this.db.select().from(customerProfiles).where(and(eq(customerProfiles.id, id), eq(customerProfiles.companyId, companyId))).limit(1);
    return row ?? null;
  }

  async listProfiles(companyId: string): Promise<CustomerProfileRow[]> {
    return await this.db
      .select()
      .from(customerProfiles)
      .where(eq(customerProfiles.companyId, companyId))
      .orderBy(asc(customerProfiles.code));
  }

  async saveProfile(
    companyId: string,
    input: {
      id?: string;
      code: string;
      name: string;
      description?: string | null;
      accountType: CustomerAccountType;
      creditLimit: number;
      paymentTermDays: number;
      transmitInvoicesToKra: boolean;
      dimensionCodes?: DimensionCodesProjection;
      isActive?: boolean;
    },
  ): Promise<CustomerProfileRow> {
    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();
    if (!has(code)) throw new Error('Profile code is required.');
    if (!has(name)) throw new Error('Profile name is required.');
    this.assertAccountType(input.accountType);
    const normalized = this.normalizeTerms(
      input.accountType,
      input.creditLimit,
      input.paymentTermDays,
    );

    const values = {
      code,
      name,
      description: emptyToNull(input.description?.trim()),
      accountType: input.accountType,
      creditLimit: money(normalized.creditLimit),
      paymentTermDays: normalized.paymentTermDays,
      transmitInvoicesToKra: input.transmitInvoicesToKra,
      dimensionCodes: input.dimensionCodes ?? emptyDimensionCodes(),
      isActive: input.isActive !== false,
      updatedAt: new Date(),
    };

    if (has(input.id)) {
      const [updated] = await this.db
        .update(customerProfiles)
        .set(values)
        .where(and(eq(customerProfiles.id, input.id), eq(customerProfiles.companyId, companyId)))
        .returning();
      if (!updated) throw new Error('Customer profile not found.');
      return updated;
    }

    const [created] = await this.db
      .insert(customerProfiles)
      .values({ companyId, ...values })
      .returning();
    return required(created, 'the saved profile');
  }

  async listCustomers(companyId: string): Promise<CustomerRow[]> {
    return await this.db
      .select()
      .from(customers)
      .where(eq(customers.companyId, companyId))
      .orderBy(desc(customers.createdAt));
  }

  /** One page of customers by name, narrowed by text (name, number, email, phone, tax PIN), 25 at a time. */
  async pageCustomers(companyId: string, input: PageInput): Promise<{ rows: CustomerRow[]; nextCursor: string | null }> {
    const text = searchText(input);
    const rows = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.companyId, companyId), matching(text, [customers.name, customers.number, customers.email, customers.phone, customers.buyerKraPin]), afterCursor(input.cursor, customers.name, customers.id)))
      .orderBy(asc(customers.name), asc(customers.id))
      .limit(PAGE_SIZE + 1);
    return pageOf(rows, PAGE_SIZE, (r) => ({ k: r.name, id: r.id }));
  }

  /** One page of profiles by code, narrowed by text, 25 at a time. */
  async pageProfiles(companyId: string, input: PageInput): Promise<{ rows: CustomerProfileRow[]; nextCursor: string | null }> {
    const text = searchText(input);
    const rows = await this.db
      .select()
      .from(customerProfiles)
      .where(and(eq(customerProfiles.companyId, companyId), matching(text, [customerProfiles.code, customerProfiles.name]), afterCursor(input.cursor, customerProfiles.code, customerProfiles.id)))
      .orderBy(asc(customerProfiles.code), asc(customerProfiles.id))
      .limit(PAGE_SIZE + 1);
    return pageOf(rows, PAGE_SIZE, (r) => ({ k: r.code, id: r.id }));
  }

  async getCustomer(
    companyId: string,
    id: string,
  ): Promise<{ customer: CustomerRow; ledger: CustomerLedgerEntryRow[] } | null> {
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.companyId, companyId)))
      .limit(1);
    if (!customer) return null;
    const ledger = await this.db
      .select()
      .from(customerLedgerEntries)
      .where(eq(customerLedgerEntries.customerId, id))
      .orderBy(desc(customerLedgerEntries.createdAt));
    return { customer, ledger };
  }

  async saveCustomer(
    companyId: string,
    input: {
      id?: string;
      profileId?: string | null;
      name: string;
      email?: string | null;
      phone?: string | null;
      street?: string | null;
      city?: string | null;
      countyOrState?: string | null;
      postalCode?: string | null;
      country?: string | null;
      accountType: CustomerAccountType;
      creditLimit: number;
      paymentTermDays: number;
      blocked?: CustomerBlock;
      transmitInvoicesToKra: boolean;
      buyerKraPin?: string | null;
      dimensionCodes?: DimensionCodesProjection;
      isActive?: boolean;
      notes?: string | null;
    },
  ): Promise<CustomerRow> {
    const name = input.name.trim();
    if (!has(name)) throw new Error('Customer name is required.');
    this.assertAccountType(input.accountType);
    const terms = this.normalizeTerms(input.accountType, input.creditLimit, input.paymentTermDays);
    const email = emptyToNull(input.email?.trim().toLowerCase());
    const phone = emptyToNull(input.phone?.trim());
    if (has(email)) await this.assertUniqueEmail(companyId, email, input.id);

    const assignment = await this.dimensionSets.resolveAssignment(
      companyId,
      input.dimensionCodes ?? emptyDimensionCodes(),
    );

    const values = {
      profileId: emptyToNull(input.profileId),
      name,
      email,
      phone,
      street: emptyToNull(input.street?.trim()),
      city: emptyToNull(input.city?.trim()),
      countyOrState: emptyToNull(input.countyOrState?.trim()),
      postalCode: emptyToNull(input.postalCode?.trim()),
      country: emptyToNull(input.country?.trim()),
      accountType: input.accountType,
      creditLimit: money(terms.creditLimit),
      paymentTermDays: terms.paymentTermDays,
      blocked: orElse(input.blocked, 'none'),
      transmitInvoicesToKra: input.transmitInvoicesToKra,
      buyerKraPin: emptyToNull(input.buyerKraPin?.trim().toUpperCase()),
      dimensionSetId: assignment.dimensionSetId,
      dimensionCodes: assignment.dimensionCodes,
      isActive: input.isActive !== false,
      notes: emptyToNull(input.notes?.trim()),
      updatedAt: new Date(),
    };

    if (has(input.id)) {
      const [updated] = await this.db
        .update(customers)
        .set(values)
        .where(and(eq(customers.id, input.id), eq(customers.companyId, companyId)))
        .returning();
      if (!updated) throw new Error('Customer not found.');
      await this.syncDefaultAddressFromCard(updated);
      return updated;
    }

    // Numbered by the customer series in the same transaction that saves the customer. (This used
    // to be count(*)+1, which two simultaneous sign-ups could both read.)
    const customerId = randomUUID();
    const [created] = await this.db.transaction(async (tx) => {
      const { number } = await getContainer().numbering.assign(
        'customer',
        { companyId, date: businessDate(), document: { kind: 'customer', id: customerId } },
        tx,
      );
      return await tx
        .insert(customers)
        .values({ id: customerId, companyId, number, balance: '0', ...values })
        .returning();
    });
    await this.syncDefaultAddressFromCard(required(created, 'the saved customer'));
    return required(created, 'the saved record');
  }

  async listAddresses(customerId: string): Promise<CustomerAddressRow[]> {
    await this.migrateLegacyAddressIfNeeded(customerId);
    return await this.db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customerId))
      .orderBy(desc(customerAddresses.isDefault), asc(customerAddresses.createdAt));
  }

  async addAddress(customerId: string, input: CustomerAddressInput): Promise<CustomerAddressRow> {
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    if (!customer) throw new Error('Customer not found.');

    const existing = await this.db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customerId));
    const makeDefault = input.isDefault === true || existing.length === 0;
    if (makeDefault && existing.length > 0) {
      await this.db
        .update(customerAddresses)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(customerAddresses.customerId, customerId));
    }

    const [created] = await this.db
      .insert(customerAddresses)
      .values({
        customerId,
        label: orElse(input.label.trim(), 'Address'),
        recipientName: input.recipientName.trim(),
        recipientPhone: input.recipientPhone.trim(),
        street: input.street.trim(),
        city: input.city.trim(),
        countyOrState: input.countyOrState.trim(),
        postalCode: emptyToNull(input.postalCode?.trim()),
        country: orElse(input.country.trim(), 'Kenya'),
        isDefault: makeDefault,
      })
      .returning();
    if (!created) throw new Error('Failed to save address.');
    if (created.isDefault) await this.mirrorDefaultOntoCustomer(customerId, created);
    return created;
  }

  async updateAddress(
    customerId: string,
    addressId: string,
    input: Partial<CustomerAddressInput>,
  ): Promise<CustomerAddressRow> {
    const [existing] = await this.db
      .select()
      .from(customerAddresses)
      .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)))
      .limit(1);
    if (!existing) throw new Error('Address not found.');

    if (input.isDefault === true && !existing.isDefault) {
      await this.db
        .update(customerAddresses)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(customerAddresses.customerId, customerId));
    }
    if (input.isDefault === false && existing.isDefault) {
      throw new Error('Choose another address as default before unsetting this one.');
    }

    const [updated] = await this.db
      .update(customerAddresses)
      .set({
        label: input.label !== undefined ? orElse(input.label.trim(), existing.label) : existing.label,
        recipientName:
          input.recipientName !== undefined ? input.recipientName.trim() : existing.recipientName,
        recipientPhone:
          input.recipientPhone !== undefined
            ? input.recipientPhone.trim()
            : existing.recipientPhone,
        street: input.street !== undefined ? input.street.trim() : existing.street,
        city: input.city !== undefined ? input.city.trim() : existing.city,
        countyOrState:
          input.countyOrState !== undefined ? input.countyOrState.trim() : existing.countyOrState,
        postalCode:
          input.postalCode !== undefined ? emptyToNull(input.postalCode?.trim()) : existing.postalCode,
        country: input.country !== undefined ? input.country.trim() : existing.country,
        isDefault: input.isDefault === true ? true : existing.isDefault,
        updatedAt: new Date(),
      })
      .where(eq(customerAddresses.id, addressId))
      .returning();
    if (!updated) throw new Error('Address not found.');
    if (updated.isDefault) await this.mirrorDefaultOntoCustomer(customerId, updated);
    return updated;
  }

  async deleteAddress(customerId: string, addressId: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customerId));
    if (rows.length <= 1) {
      throw new Error('A customer must keep at least one address.');
    }
    const target = rows.find((row) => row.id === addressId);
    if (!target) throw new Error('Address not found.');

    await this.db
      .delete(customerAddresses)
      .where(
        and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)),
      );

    if (target.isDefault) {
      const remaining = rows.filter((row) => row.id !== addressId);
      const next = nth(remaining, 0);
      await this.db
        .update(customerAddresses)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(customerAddresses.id, next.id));
      await this.mirrorDefaultOntoCustomer(customerId, { ...next, isDefault: true });
    }
  }

  async setDefaultAddress(customerId: string, addressId: string): Promise<CustomerAddressRow[]> {
    const [target] = await this.db
      .select()
      .from(customerAddresses)
      .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)))
      .limit(1);
    if (!target) throw new Error('Address not found.');

    await this.db
      .update(customerAddresses)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(customerAddresses.customerId, customerId));
    const [updated] = await this.db
      .update(customerAddresses)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(customerAddresses.id, addressId))
      .returning();
    await this.mirrorDefaultOntoCustomer(customerId, required(updated, 'the address'));
    return await this.listAddresses(customerId);
  }

  /**
   * Find or create the sell-to card for a storefront login (by email).
   * Does not invent an address — callers add one before checkout if needed.
   */
  async ensureStorefrontCustomer(
    companyId: string,
    input: { name: string; email: string; phone?: string | null },
  ): Promise<CustomerRow> {
    const email = input.email.trim().toLowerCase();
    if (!email.includes('@')) throw new Error('A valid email is required.');
    const existing = await this.lookupByEmail(companyId, email);
    if (existing) {
      const nextName = orElse(input.name.trim(), existing.name);
      const nextPhone = orElse(input.phone?.trim(), existing.phone);
      if (nextName !== existing.name || nextPhone !== existing.phone) {
        return await this.saveCustomer(companyId, {
          id: existing.id,
          profileId: existing.profileId,
          name: nextName,
          email: existing.email,
          phone: nextPhone,
          street: existing.street,
          city: existing.city,
          countyOrState: existing.countyOrState,
          postalCode: existing.postalCode,
          country: existing.country,
          accountType: existing.accountType === 'credit' ? 'credit' : 'cash',
          creditLimit: num(existing.creditLimit),
          paymentTermDays: existing.paymentTermDays,
          blocked: orElse(existing.blocked, 'none') as CustomerBlock,
          transmitInvoicesToKra: existing.transmitInvoicesToKra,
          buyerKraPin: existing.buyerKraPin,
          dimensionCodes: existing.dimensionCodes,
          isActive: existing.isActive,
          notes: existing.notes,
        });
      }
      return existing;
    }
    return await this.saveCustomer(companyId, {
      name: orElse(input.name.trim(), orElse(email.split('@')[0], 'Customer')),
      email,
      phone: emptyToNull(input.phone?.trim()),
      accountType: 'cash',
      creditLimit: 0,
      paymentTermDays: 0,
      transmitInvoicesToKra: true,
      dimensionCodes: emptyDimensionCodes(),
    });
  }

  async deleteCustomer(companyId: string, id: string): Promise<void> {
    const found = await this.getCustomer(companyId, id);
    if (!found) throw new Error('Customer not found.');
    // The customer ledger is a record that cannot be deleted, so a customer with history is blocked
    // instead (this also stops the database refusing the cascade with an unreadable message).
    if (found.ledger.length > 0) {
      throw new Error(
        `${found.customer.name} has financial history and cannot be deleted. Block the customer instead.`,
      );
    }
    await this.db
      .delete(customers)
      .where(and(eq(customers.id, id), eq(customers.companyId, companyId)));
  }

  async lookupByEmail(companyId: string, email: string): Promise<CustomerRow | null> {
    const normalized = email.trim().toLowerCase();
    if (!has(normalized)) return null;
    const [row] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.companyId, companyId), eq(customers.email, normalized)))
      .limit(1);
    return row ?? null;
  }

  /** A guest who gave no email is the same person when the phone matches a card that has no email. */
  async lookupGuestByPhone(companyId: string, phone: string): Promise<CustomerRow | null> {
    const normalized = phone.trim();
    if (!has(normalized)) return null;
    const [row] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.companyId, companyId), eq(customers.phone, normalized), isNull(customers.email)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Find or create the customer for a sale and reject blocked or over-limit credit sales.
   * Does not post the ledger — call postInvoice after the order is saved.
   */
  async prepareSale(input: {
    companyId: string;
    name: string;
    email: string;
    phone: string;
    address: {
      street: string;
      city: string;
      countyOrState: string;
      postalCode?: string;
      country: string;
    };
    buyerKraPin?: string | null;
    amount: number;
    onAccount: boolean;
    /** Let an order over the credit limit through; the caller must then get it approved. */
    allowOverLimit?: boolean;
  }): Promise<CustomerRow> {
    let customer =
      input.email.trim() === ''
        ? await this.lookupGuestByPhone(input.companyId, input.phone)
        : await this.lookupByEmail(input.companyId, input.email);
    const pin = emptyToNull(input.buyerKraPin?.trim().toUpperCase());
    if (!customer) {
      customer = await this.saveCustomer(input.companyId, {
        name: input.name,
        email: input.email,
        phone: input.phone,
        street: input.address.street,
        city: input.address.city,
        countyOrState: input.address.countyOrState,
        postalCode: input.address.postalCode,
        country: input.address.country,
        accountType: 'cash',
        creditLimit: 0,
        paymentTermDays: 0,
        transmitInvoicesToKra: true,
        buyerKraPin: pin,
        dimensionCodes: emptyDimensionCodes(),
      });
    } else {
      customer = await this.saveCustomer(input.companyId, {
        id: customer.id,
        profileId: customer.profileId,
        name: orElse(input.name.trim(), customer.name),
        email: customer.email,
        phone: orElse(input.phone.trim(), customer.phone),
        street: customer.street,
        city: customer.city,
        countyOrState: customer.countyOrState,
        postalCode: customer.postalCode,
        country: customer.country,
        accountType: customer.accountType === 'credit' ? 'credit' : 'cash',
        creditLimit: num(customer.creditLimit),
        paymentTermDays: customer.paymentTermDays,
        blocked: orElse(customer.blocked, 'none') as CustomerBlock,
        transmitInvoicesToKra: customer.transmitInvoicesToKra,
        buyerKraPin: orElse(pin, customer.buyerKraPin),
        dimensionCodes: customer.dimensionCodes,
        isActive: customer.isActive,
        notes: customer.notes,
      });
      const addresses = await this.listAddresses(customer.id);
      if (addresses.length === 0 && has(input.address.street.trim()) && has(input.address.city.trim())) {
        try {
          await this.addAddress(customer.id, {
            label: 'Delivery',
            recipientName: input.name,
            recipientPhone: input.phone,
            street: input.address.street,
            city: input.address.city,
            countyOrState: input.address.countyOrState,
            postalCode: input.address.postalCode,
            country: input.address.country,
            isDefault: true,
          });
        } catch (error) {
          // Simultaneous first orders race to save the default address. The unique index lets
          // one win; the others already have an address on file and carry on.
          if (!isUniqueViolation(error)) throw error;
        }
      }
    }

    if (!customer.isActive || customer.blocked === 'invoice' || customer.blocked === 'all') {
      throw new Error(`${customer.name} is blocked and cannot be invoiced.`);
    }
    if (input.onAccount && customer.accountType !== 'credit') {
      throw new Error(`${customer.name} is a cash customer and must pay at the invoice.`);
    }

    if (customer.accountType === 'credit') {
      const nextBalance = num(customer.balance) + input.amount;
      if (nextBalance > num(customer.creditLimit) && input.allowOverLimit !== true) {
        throw new Error(
          `${customer.name} would exceed the credit limit of ${num(customer.creditLimit).toLocaleString()}.`,
        );
      }
    }

    return customer;
  }

  async postInvoice(input: {
    customer: CustomerRow;
    orderId: string;
    orderNumber: string;
    amount: number;
    currency: string;
  }): Promise<void> {
    const amount = Math.round(input.amount * 100) / 100;
    const openReceivable = input.customer.accountType === 'credit';
    const due = new Date();
    due.setDate(due.getDate() + input.customer.paymentTermDays);
    const description = openReceivable ? 'Credit invoice' : 'Cash invoice';

    // One transaction: the ledger entry, its history, the balance and the transaction-ledger debit
    // either all exist or none do.
    await this.db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(customerLedgerEntries)
        .values({
          companyId: input.customer.companyId,
          customerId: input.customer.id,
          orderId: input.orderId,
          documentType: 'invoice',
          documentNo: input.orderNumber,
          description,
          amount: money(amount),
          remainingAmount: money(openReceivable ? amount : 0),
          dueDate: due,
          // Set to its final value by the signing service once the invoice has been considered.
          kraTransmissionStatus: 'pending',
          postingDate: businessDate(),
          currency: input.currency.trim().toUpperCase(),
        })
        .returning({ id: customerLedgerEntries.id });
      const history: (typeof customerDetailedEntries.$inferInsert)[] = [
        {
          companyId: input.customer.companyId,
          customerId: input.customer.id,
          ledgerEntryId: required(entry, 'the invoice entry').id,
          entryType: 'initial',
          amount: money(amount),
          postingDate: businessDate(),
        },
      ];
      if (!openReceivable) {
        // A cash customer pays at the sale, so nothing stays open on the invoice.
        history.push({
          companyId: input.customer.companyId,
          customerId: input.customer.id,
          ledgerEntryId: required(entry, 'the invoice entry').id,
          entryType: 'application',
          amount: money(-amount),
          postingDate: businessDate(),
        });
      }
      await tx.insert(customerDetailedEntries).values(history);

      if (openReceivable) {
        await tx
          .update(customers)
          .set({ balance: sql`${customers.balance} + ${money(amount)}::numeric`, updatedAt: new Date() })
          .where(eq(customers.id, input.customer.id));
      }

      // A credit invoice reaches the general ledger once it is live; queued in this same transaction.
      if (openReceivable) {
        // Paid from the customer's wallet first, when the policy says so (it can never stop the sale).
        await getContainer().finance.wallets.autoApplyToInvoiceIn(tx, {
          companyId: input.customer.companyId,
          customerId: input.customer.id,
          currency: input.currency.trim().toUpperCase(),
          invoiceEntryId: required(entry, 'the invoice entry').id,
          invoiceCents: Math.round(amount * 100),
        });
        await getContainer().finance.salesPosting.enqueue(tx, {
          companyId: input.customer.companyId,
          kind: 'invoice',
          subjectId: input.orderId,
        });
      }

      await this.ledger.post(
        {
          companyId: input.customer.companyId,
          customerId: input.customer.id,
          orderId: input.orderId,
          documentType: 'invoice',
          documentNo: input.orderNumber,
          description,
          direction: 'debit',
          amount,
          currency: input.currency,
          idempotencyKey: `invoice:${input.orderId}`,
        },
        tx,
      );
    });
  }

  async applyOrderPayment(orderId: string): Promise<void> {
    const [entry] = await this.db
      .select()
      .from(customerLedgerEntries)
      .where(
        and(
          eq(customerLedgerEntries.orderId, orderId),
          eq(customerLedgerEntries.documentType, 'invoice'),
        ),
      )
      .limit(1);
    if (!entry) return;
    if (num(entry.remainingAmount) <= 0) {
      // A cash customer's invoice is closed at the sale; the money arriving is what the books
      // record now (the bank movement and, once live, the sale itself).
      const [cust] = await this.db.select({ t: customers.accountType }).from(customers).where(eq(customers.id, entry.customerId));
      if (cust?.t !== 'credit') {
        await getContainer().finance.salesPosting.enqueue(this.db, { companyId: entry.companyId, kind: 'cash_sale', subjectId: orderId });
      }
      return;
    }

    const [order] = await this.db
      .select({
        paymentMethod: orders.paymentMethod,
        transactionReference: orders.transactionReference,
        mpesaReceiptNumber: orders.mpesaReceiptNumber,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    const reference = shownPaymentReference(order ?? {});
    if (!has(reference)) {
      throw new Error(
        'Cannot post this payment. The provider transaction reference was not captured.',
      );
    }

    await this.receivePayment(entry.companyId, entry.customerId, {
      amount: num(entry.remainingAmount),
      reference,
      orderId,
    });
  }

  async receivePayment(
    companyId: string,
    customerId: string,
    input: { amount: number; reference?: string; orderId?: string; currency?: string },
  ): Promise<CustomerRow> {
    const found = await this.getCustomer(companyId, customerId);
    if (!found) throw new Error('Customer not found.');
    const amount = Math.round(input.amount * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0)
      throw new Error('Payment amount must be greater than 0.');

    const documentNo = orElse(input.reference?.trim(), '');
    if (!has(documentNo)) {
      throw new Error('A payment needs the provider transaction reference.');
    }

    if (!has(input.orderId) && (await getContainer().finance.salesPosting.isLive(companyId))) {
      // Money taken by hand needs a payment method and a bank account; the books are live, so it
      // goes through Finance → Receipts, where those are recorded.
      throw new Error('Sales now post to the general ledger. Record this payment under Finance → Receipts so it reaches the bank account and the books.');
    }
    return await this.db.transaction(async (tx) => {
      // Lock the open invoices so two payments arriving together cannot both settle the same one.
      const open = await tx
        .select()
        .from(customerLedgerEntries)
        .where(
          and(
            eq(customerLedgerEntries.customerId, customerId),
            eq(customerLedgerEntries.documentType, 'invoice'),
            sql`${customerLedgerEntries.remainingAmount} > 0`,
          ),
        )
        .orderBy(asc(customerLedgerEntries.createdAt), asc(customerLedgerEntries.id))
        .for('update');
      const openTotal = open.reduce((sum, entry) => sum + num(entry.remainingAmount), 0);
      if (amount > openTotal + 0.001) {
        throw new Error('Payment is larger than the open balance.');
      }
      const currency = await this.currencyForPosting(
        input.currency,
        orElse(input.orderId, open.find((entry) => has(entry.orderId))?.orderId),
      );

      const [payment] = await tx
        .insert(customerLedgerEntries)
        .values({
          companyId,
          customerId,
          orderId: emptyToNull(input.orderId),
          documentType: 'payment',
          documentNo,
          description: 'Customer payment',
          amount: money(-amount),
          remainingAmount: '0',
          kraTransmissionStatus: 'not_applicable',
          postingDate: businessDate(),
          currency,
        })
        .returning({ id: customerLedgerEntries.id });

      if (has(input.orderId)) {
        await getContainer().finance.salesPosting.enqueue(tx, { companyId, kind: 'credit_payment', subjectId: required(payment, 'the payment entry').id });
      }

      const history: (typeof customerDetailedEntries.$inferInsert)[] = [
        {
          companyId,
          customerId,
          ledgerEntryId: required(payment, 'the payment entry').id,
          entryType: 'initial',
          amount: money(-amount),
          postingDate: businessDate(),
        },
      ];
      let left = amount;
      for (const entry of open) {
        if (left <= 0) break;
        const remaining = num(entry.remainingAmount);
        const applied = Math.min(remaining, left);
        await tx
          .update(customerLedgerEntries)
          .set({ remainingAmount: money(remaining - applied) })
          .where(eq(customerLedgerEntries.id, entry.id));
        const base = { companyId, customerId, entryType: 'application' as const, postingDate: businessDate() };
        history.push(
          { ...base, ledgerEntryId: entry.id, amount: money(-applied), appliedToEntryId: required(payment, 'the payment entry').id },
          { ...base, ledgerEntryId: required(payment, 'the payment entry').id, amount: money(applied), appliedToEntryId: entry.id },
        );
        left -= applied;
      }
      await tx.insert(customerDetailedEntries).values(history);

      await this.ledger.post(
        {
          companyId,
          customerId,
          orderId: emptyToNull(input.orderId),
          documentType: 'payment',
          documentNo,
          description: 'Customer payment',
          direction: 'credit',
          amount,
          currency,
          transactionReference: documentNo,
          idempotencyKey: has(input.orderId)
            ? `payment:${input.orderId}:${documentNo}:${money(amount)}`
            : `payment:${customerId}:${documentNo}:${money(amount)}:${open.map((entry) => entry.id).join(',')}`,
        },
        tx,
      );

      const [updated] = await tx
        .update(customers)
        .set({
          balance: sql`GREATEST(${customers.balance} - ${money(amount)}::numeric, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, customerId))
        .returning();
      return required(updated, 'the customer');
    });
  }

  private async currencyForPosting(
    explicit: string | undefined,
    orderId?: string | null,
  ): Promise<string> {
    const given = explicit?.trim();
    if (has(given)) return given.toUpperCase();
    if (has(orderId)) {
      const [order] = await this.db
        .select({ currency: orders.currency })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      const fromOrder = order?.currency.trim();
      if (has(fromOrder)) return fromOrder.toUpperCase();
    }
    throw new Error('A currency is required to post the transaction ledger.');
  }

  private assertAccountType(value: string): asserts value is CustomerAccountType {
    if (value !== 'cash' && value !== 'credit') {
      throw new Error('Customer account type must be cash or credit.');
    }
  }

  private normalizeTerms(
    accountType: CustomerAccountType,
    creditLimit: number,
    paymentTermDays: number,
  ) {
    if (accountType === 'cash') return { creditLimit: 0, paymentTermDays: 0 };
    if (!Number.isFinite(creditLimit) || creditLimit < 0) {
      throw new Error('Credit limit must be 0 or greater.');
    }
    if (!Number.isInteger(paymentTermDays) || paymentTermDays < 0) {
      throw new Error('Payment terms must be a number of days, 0 or greater.');
    }
    return { creditLimit, paymentTermDays };
  }

  private async assertUniqueEmail(companyId: string, email: string, exceptId?: string) {
    const existing = await this.lookupByEmail(companyId, email);
    if (existing && existing.id !== exceptId) {
      throw new Error(`A customer with email ${email} already exists (${existing.number}).`);
    }
  }

  /** Mirror default address onto the customer card fields used by admin lists / invoices. */
  private async mirrorDefaultOntoCustomer(customerId: string, address: CustomerAddressRow) {
    await this.db
      .update(customers)
      .set({
        street: address.street,
        city: address.city,
        countyOrState: address.countyOrState,
        postalCode: address.postalCode,
        country: address.country,
        updatedAt: new Date(),
      })
      .where(eq(customers.id, customerId));
  }

  /**
   * When admin saves street/city on the customer card, keep a default address row in sync.
   * Skips when the card has no usable address yet.
   */
  private async syncDefaultAddressFromCard(customer: CustomerRow) {
    if (!has(customer.street?.trim()) || !has(customer.city?.trim())) return;
    const rows = await this.db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customer.id));
    if (rows.length === 0) {
      await this.db.insert(customerAddresses).values({
        customerId: customer.id,
        label: 'Primary',
        recipientName: customer.name,
        recipientPhone: orElse(customer.phone, ''),
        street: customer.street.trim(),
        city: customer.city.trim(),
        countyOrState: orElse(customer.countyOrState?.trim(), ''),
        postalCode: emptyToNull(customer.postalCode?.trim()),
        country: orElse(customer.country?.trim(), 'Kenya'),
        isDefault: true,
      });
      return;
    }
    const def = rows.find((row) => row.isDefault) ?? nth(rows, 0);
    if (!def.isDefault) {
      await this.db
        .update(customerAddresses)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(customerAddresses.customerId, customer.id));
    }
    await this.db
      .update(customerAddresses)
      .set({
        street: customer.street.trim(),
        city: customer.city.trim(),
        countyOrState: orElse(customer.countyOrState?.trim(), def.countyOrState),
        postalCode: emptyToNull(customer.postalCode?.trim()),
        country: orElse(customer.country?.trim(), def.country),
        isDefault: true,
        updatedAt: new Date(),
      })
      .where(eq(customerAddresses.id, def.id));
  }

  /** One-time backfill from denormalized customer card fields into customer_addresses. */
  private async migrateLegacyAddressIfNeeded(customerId: string) {
    const rows = await this.db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customerId));
    if (rows.length > 0) return;
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    if (!has(customer?.street?.trim()) || !has(customer.city?.trim())) return;
    await this.db.insert(customerAddresses).values({
      customerId,
      label: 'Primary',
      recipientName: customer.name,
      recipientPhone: orElse(customer.phone, ''),
      street: customer.street.trim(),
      city: customer.city.trim(),
      countyOrState: orElse(customer.countyOrState?.trim(), ''),
      postalCode: emptyToNull(customer.postalCode?.trim()),
      country: orElse(customer.country?.trim(), 'Kenya'),
      isDefault: true,
    });
  }
}
