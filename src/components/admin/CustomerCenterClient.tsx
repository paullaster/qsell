'use client';

import Link from 'next/link';
import { Suspense, use } from 'react';
import type { customerCardAction } from '@/server/domains/customers/manage-actions';
import type { customerStatementAction } from '@/server/domains/finance/receivables/actions';
import type { customerWalletAction } from '@/server/domains/finance/wallet-actions';
import { labelOfAccountType, labelOfBlock } from '@/lib/customer-forms';
import { CustomerStatementPanel } from './finance/CustomerStatementClient';
import {
  Chip,
  LoadFailed,
  PageHeader,
  buttonClass,
  cardClass,
  money,
  primaryClass,
} from './finance/ui';

interface Props {
  cardPromise: ReturnType<typeof customerCardAction>;
  statementPromise: ReturnType<typeof customerStatementAction> | null;
  walletPromise: ReturnType<typeof customerWalletAction> | null;
  canEditPromise: Promise<boolean>;
  canReceivePromise: Promise<boolean>;
  canReadReceiptsPromise: Promise<boolean>;
  canReadOrdersPromise: Promise<boolean>;
}

const shown = (value: string | null | undefined): string =>
  value === null || value === undefined || value.trim() === '' ? '—' : value;

export function CustomerCenterClient({
  cardPromise,
  statementPromise,
  walletPromise,
  canEditPromise,
  canReceivePromise,
  canReadReceiptsPromise,
  canReadOrdersPromise,
}: Props) {
  const card = use(cardPromise);
  const canEdit = use(canEditPromise);
  const canReceive = use(canReceivePromise);
  const canReadReceipts = use(canReadReceiptsPromise);
  const canReadOrders = use(canReadOrdersPromise);
  if (!card.ok) return <LoadFailed error={card.error} />;

  const customer = card.data.customer;
  const actions = (
    <>
      {canEdit ? (
        <Link className={buttonClass} href={`/admin/customers/${customer.id}/edit`}>
          Edit customer
        </Link>
      ) : null}
      {canReceive ? (
        <Link
          className={primaryClass}
          href={`/admin/finance/receipts/new?customer=${encodeURIComponent(customer.number)}`}
        >
          Record a receipt
        </Link>
      ) : null}
    </>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <PageHeader
        title={customer.name}
        intro={
          <span className="flex flex-wrap items-center gap-2">
            Customer {customer.number} ·{' '}
            <Chip tone={customer.accountType === 'credit' ? 'sky' : 'gray'}>
              {labelOfAccountType(customer.accountType)}
            </Chip>
            {customer.blocked !== 'none' ? (
              <Chip tone="red">Blocked: {labelOfBlock(customer.blocked)}</Chip>
            ) : null}
            {!customer.isActive ? <Chip tone="amber">Inactive</Chip> : null}
          </span>
        }
        actions={actions}
      />

      <section aria-labelledby="customer-information-heading" className={cardClass}>
        <h3 id="customer-information-heading" className="text-sm font-bold text-fg-strong">
          Customer information
        </h3>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Info label="Customer number" value={customer.number} mono />
          <Info label="Profile" value={card.data.profileLabel} />
          <Info label="Account type" value={labelOfAccountType(customer.accountType)} />
          <Info label="Email" value={customer.email} />
          <Info label="Phone" value={customer.phone} />
          <Info label="Tax PIN" value={customer.buyerKraPin} mono />
          <Info label="Street" value={customer.street} />
          <Info label="City" value={customer.city} />
          <Info label="County / region" value={customer.countyOrState} />
          <Info label="Postal code" value={customer.postalCode} />
          <Info label="Country" value={customer.country} />
          <Info label="Payment terms" value={`${customer.paymentTermDays} days`} />
          <Info
            label="Credit limit"
            value={customer.accountType === 'credit' ? money(customer.creditLimit) : '—'}
          />
          <Info label="KRA invoices" value={customer.transmitInvoicesToKra ? 'Transmit' : 'Skip'} />
          <Info label="Notes" value={customer.notes} />
        </dl>
      </section>

      <section aria-label="Customer balance" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Balance title="Balance" value={money(customer.balance)} />
        <Balance title="Open items" value={String(card.data.ledger.length)} />
        <Balance
          title="Credit limit"
          value={customer.accountType === 'credit' ? money(customer.creditLimit) : '—'}
        />
        <Balance title="Status" value={customer.isActive ? 'Active' : 'Inactive'} />
      </section>

      {statementPromise === null ? (
        <p className="rounded-xl border border-line bg-surface-raised p-4 text-sm text-fg-muted">
          The statement and transaction history need customer ledger access.
        </p>
      ) : (
        <section aria-labelledby="customer-statement-heading" className="space-y-3">
          <h3 id="customer-statement-heading" className="text-sm font-bold text-fg-strong">
            Statement and transactions
          </h3>
          <Suspense
            fallback={
              <p className="text-sm text-fg-muted" role="status">
                Loading the statement…
              </p>
            }
          >
            <StatementSection
              statementPromise={statementPromise}
              walletPromise={walletPromise}
              canReadReceipts={canReadReceipts}
              canReadOrders={canReadOrders}
            />
          </Suspense>
        </section>
      )}
    </div>
  );
}

function Info({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={`mt-0.5 text-fg-strong ${mono ? 'font-mono text-xs' : ''}`}>{shown(value)}</dd>
    </div>
  );
}

function Balance({ title, value }: { title: string; value: string }) {
  return (
    <div className={cardClass}>
      <p className="text-xs text-fg-muted">{title}</p>
      <p className="text-lg font-bold text-fg-strong tabular-nums">{value}</p>
    </div>
  );
}

function StatementSection({
  statementPromise,
  walletPromise,
  canReadReceipts,
  canReadOrders,
}: {
  statementPromise: ReturnType<typeof customerStatementAction>;
  walletPromise: ReturnType<typeof customerWalletAction> | null;
  canReadReceipts: boolean;
  canReadOrders: boolean;
}) {
  const statement = use(statementPromise);
  if (!statement.ok) return <LoadFailed error={statement.error} />;
  return (
    <CustomerStatementPanel
      initial={statement.data}
      canReadReceipts={canReadReceipts}
      canReadOrders={canReadOrders}
      walletPromise={walletPromise}
    />
  );
}
