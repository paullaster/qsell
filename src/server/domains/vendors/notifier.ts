import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { vendorContacts, vendors } from '@/server/db/drizzle/schema';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import type { EmailMessage, EmailPort } from '@/server/ports/communications';
import { resolvePublicBaseUrl } from '@/server/domains/auth/account-service';
import { layout } from '@/server/domains/auth/emails';
import { sectionLabel } from '@/lib/vendor-profile';

interface Mail {
  heading: string;
  body: string;
  cta: string;
  path: string;
  details?: readonly (readonly [string, string])[];
  footer?: string;
}

/**
 * The mail vendors and staff get about onboarding, bank changes and expiring documents (design doc §20). A message that cannot
 * be sent is written to the log and never stops the decision it is about: the decision is already saved and shown in the
 * vendor's history. Links are built from configuration only, never from a request.
 */
export class VendorNotifier {
  constructor(
    private readonly db: DrizzleDb,
    private readonly email: EmailPort,
    private readonly company: CompanySettingsRepository,
  ) {}

  private async send(to: string[], subject: string, mail: Mail, audience: 'vendor' | 'staff'): Promise<void> {
    const recipients = [...new Set(to.map((a) => a.trim().toLowerCase()).filter((a) => a !== ''))];
    if (recipients.length === 0) return;
    try {
      const settings = await this.company.ensureSeeded();
      const base = resolvePublicBaseUrl(settings.publicBaseUrl);
      const url = `${base}${mail.path}`;
      const store = settings.tradingName.trim() === '' ? 'our store' : settings.tradingName;
      const footer = mail.footer ?? (audience === 'vendor' ? `You are receiving this because your business is a vendor of ${store}.` : 'You are receiving this because you manage vendors.');
      const html = layout({ heading: mail.heading, greeting: 'Hello,', body: mail.body, cta: mail.cta, actionUrl: url, footer, details: mail.details });
      const text = `${mail.heading}\n\n${mail.body}\n\n${(mail.details ?? []).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${mail.cta}: ${url}\n\n${footer}`;
      for (const to1 of recipients) {
        const message: EmailMessage = { to: to1, subject: `${subject} · ${store}`, html, text };
        await this.email.send(message);
      }
    } catch (error) {
      console.error('[vendor.notify] mail not sent', { subject, error });
    }
  }

  /** The vendor's own address and the people it named as contacts; the owner is always among them. */
  private async vendorAddresses(vendorId: string, only?: 'finance' | 'all'): Promise<{ legalName: string; addresses: string[] }> {
    const [v] = await this.db.select({ legalName: vendors.legalName, email: vendors.email }).from(vendors).where(eq(vendors.id, vendorId));
    if (v === undefined) return { legalName: '', addresses: [] };
    const contacts = await this.db.select({ email: vendorContacts.email, role: vendorContacts.role, isPrimary: vendorContacts.isPrimary }).from(vendorContacts).where(eq(vendorContacts.vendorId, vendorId));
    const picked = contacts.filter((c) => only !== 'finance' || c.role === 'finance' || c.role === 'management' || c.isPrimary);
    return { legalName: v.legalName, addresses: [v.email, ...picked.map((c) => c.email)] };
  }

  private async staffAddress(): Promise<string[]> {
    const settings = await this.company.ensureSeeded();
    return [settings.email];
  }

  async applicationReceived(vendorId: string, version: number): Promise<void> {
    const { legalName } = await this.vendorAddresses(vendorId);
    await this.send(await this.staffAddress(), 'A vendor application is waiting', {
      heading: 'A vendor sent its profile for review',
      body: `${legalName} sent its profile (version ${String(version)}). Open the review queue to take it.`,
      cta: 'Open the review queue',
      path: '/admin/vendors/review',
    }, 'staff');
  }

  async revisionRequested(vendorId: string, notes: Partial<Record<string, string>>, comment: string | null): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    const details = Object.entries(notes).map(([k, v]) => [sectionLabel(k), v ?? ''] as const);
    await this.send(addresses, 'Please update your vendor profile', {
      heading: 'We need a few changes to your profile',
      body: comment === null ? 'We reviewed your profile and need you to change the sections below, then send it again.' : `We reviewed your profile and need you to change the sections below, then send it again. ${comment}`,
      cta: 'Open my profile',
      path: '/vendor/profile',
      details,
    }, 'vendor');
  }

  async approved(vendorId: string, number: string): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    await this.send(addresses, 'Your vendor application is approved', {
      heading: 'Your business is now an approved vendor',
      body: 'Your profile was reviewed and approved. You can keep your contacts and documents up to date from the vendor portal.',
      cta: 'Open the vendor portal',
      path: '/vendor',
      details: [['Vendor number', number]],
    }, 'vendor');
  }

  async refused(vendorId: string, reason: string): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    await this.send(addresses, 'About your vendor application', {
      heading: 'We could not accept your application',
      body: 'Your application was reviewed and was not accepted. You may apply again after 30 days.',
      cta: 'Open the vendor portal',
      path: '/vendor',
      details: [['Reason', reason]],
    }, 'vendor');
  }

  async bankChangeProposed(vendorId: string, bankName: string, last4: string): Promise<void> {
    const { legalName, addresses } = await this.vendorAddresses(vendorId, 'finance');
    const details = [['Bank', bankName], ['Account ending', last4]] as const;
    await this.send(addresses, 'A bank account change was requested', {
      heading: 'A change to your bank details was requested',
      body: 'Someone at your business asked to add or change a bank account. If this was not you, tell us at once: no money will be sent to the new account until we have confirmed it with you by phone.',
      cta: 'Open the vendor portal',
      path: '/vendor/profile/financial',
      details,
    }, 'vendor');
    await this.send(await this.staffAddress(), 'A vendor asked to change bank details', {
      heading: `${legalName} asked to change its bank details`,
      body: 'Call the vendor on the number we hold, record the call, then ask a second person to approve.',
      cta: 'Open bank changes',
      path: '/admin/vendors/bank-changes',
      details,
    }, 'staff');
  }

  async bankChangeDecided(vendorId: string, outcome: 'approved' | 'refused', note: string | null, effectiveFrom: Date | null): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId, 'finance');
    const details: [string, string][] = [];
    if (effectiveFrom !== null) details.push(['In use from', effectiveFrom.toISOString().slice(0, 10)]);
    if (note !== null) details.push(['Note', note]);
    await this.send(addresses, outcome === 'approved' ? 'Your bank change is approved' : 'Your bank change was not accepted', {
      heading: outcome === 'approved' ? 'Your new bank account is approved' : 'Your bank change was not accepted',
      body: outcome === 'approved' ? 'Payments will move to the new account after a short waiting period, which protects you from fraud.' : 'We could not accept the requested change. Your existing bank details are unchanged.',
      cta: 'Open the vendor portal',
      path: '/vendor/profile/financial',
      details,
    }, 'vendor');
  }

  async documentExpiring(vendorId: string, typeName: string, expiresOn: string, daysLeft: number): Promise<void> {
    const { legalName, addresses } = await this.vendorAddresses(vendorId);
    const when = daysLeft <= 0 ? 'expires today' : `expires in ${String(daysLeft)} days`;
    await this.send(addresses, `Your ${typeName.toLowerCase()} ${when}`, {
      heading: `Your ${typeName.toLowerCase()} ${when}`,
      body: 'Upload a current copy in the vendor portal so we can keep buying from you.',
      cta: 'Upload a new document',
      path: '/vendor/profile/attachments',
      details: [['Document', typeName], ['Expires on', expiresOn]],
    }, 'vendor');
    if (daysLeft <= 7) {
      await this.send(await this.staffAddress(), `${legalName}: ${typeName.toLowerCase()} ${when}`, {
        heading: `${legalName}'s ${typeName.toLowerCase()} ${when}`,
        body: 'The vendor has been reminded.',
        cta: 'Open expiring documents',
        path: '/admin/vendors/expiring',
        details: [['Vendor', legalName], ['Expires on', expiresOn]],
      }, 'staff');
    }
  }

  async documentExpired(vendorId: string, typeName: string, expiresOn: string): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    await this.send(addresses, `Your ${typeName.toLowerCase()} has expired`, {
      heading: `Your ${typeName.toLowerCase()} has expired`,
      body: 'Upload a current copy in the vendor portal.',
      cta: 'Upload a new document',
      path: '/vendor/profile/attachments',
      details: [['Document', typeName], ['Expired on', expiresOn]],
    }, 'vendor');
  }

  /** Mailed to someone invited to a vendor's portal; `path` carries the single-use link. */
  async invitation(to: string, name: string, businessName: string, path: string, role: string): Promise<void> {
    await this.send([to], 'You are invited to the vendor portal', {
      heading: `Join ${businessName} in the vendor portal`,
      body: `Hello ${name}, you have been invited to manage ${businessName} as a vendor. Choose a password to start; this link works for 7 days.`,
      cta: 'Choose my password',
      path,
      details: [['Your role', role]],
      footer: 'If you did not expect this invitation, ignore this email: nothing happens until you use the link.',
    }, 'vendor');
  }

  async suspended(vendorId: string, reason: string): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    await this.send(addresses, 'Your vendor account is suspended', {
      heading: 'Your vendor account is suspended',
      body: 'We have paused your vendor account. Contact the buyer to understand the reason and the way back.',
      cta: 'Open the vendor portal',
      path: '/vendor',
      details: [['Reason', reason]],
    }, 'vendor');
  }

  async prequalSubmitted(vendorId: string, categoryName: string): Promise<void> {
    const { legalName } = await this.vendorAddresses(vendorId);
    await this.send(await this.staffAddress(), 'A prequalification application is waiting', {
      heading: `${legalName} applied to be qualified`,
      body: `${legalName} applied for ${categoryName}. Take it for evaluation from the prequalification queue.`,
      cta: 'Open the queue',
      path: '/admin/vendors/prequalification',
    }, 'staff');
  }

  async prequalDecided(vendorId: string, categoryName: string, outcome: 'approved' | 'rejected' | 'revision' | 'suspended' | 'revoked' | 'reinstated' | 'expired', note: string | null, until: string | null): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    const words = {
      approved: ['You are qualified', 'Your application was approved.'],
      rejected: ['Your application was not accepted', 'Your application was reviewed and was not accepted.'],
      revision: ['We need changes to your application', 'Please update your answers and send the application again.'],
      suspended: ['Your qualification is suspended', 'Your qualification is paused until the reason below is resolved.'],
      revoked: ['Your qualification was withdrawn', 'We have withdrawn your qualification.'],
      reinstated: ['Your qualification is back', 'Your qualification is active again.'],
      expired: ['Your qualification has expired', 'Apply again to renew it: your earlier answers are filled in for you.'],
    } as const;
    const [heading, body] = words[outcome];
    const details: [string, string][] = [['Category', categoryName]];
    if (until !== null) details.push(['Qualified until', until]);
    if (note !== null) details.push(['Note', note]);
    await this.send(addresses, `${heading}: ${categoryName}`, { heading, body, cta: 'Open prequalification', path: '/vendor/prequalification', details }, 'vendor');
  }

  /** Every vendor's own contacts, separately: one invitation each, never a shared list of who else was invited. */
  private async eachVendor(vendorIds: string[], make: (vendorId: string, addresses: string[]) => Promise<void>): Promise<void> {
    for (const id of vendorIds) {
      const { addresses } = await this.vendorAddresses(id);
      await make(id, addresses);
    }
  }

  async rfqInvited(vendorIds: string[], number: string, title: string, deadline: Date): Promise<void> {
    await this.eachVendor(vendorIds, async (_id, addresses) => {
      await this.send(addresses, `You are invited to quote: ${number}`, {
        heading: `You are invited to quote for ${title}`,
        body: 'Open the request in the vendor portal to read what is wanted and send your quote before the deadline.',
        cta: 'Open the request',
        path: '/vendor/rfqs',
        details: [['Request', number], ['Quotes are due', `${deadline.toISOString().replace('T', ' ').slice(0, 16)  } UTC`]],
      }, 'vendor');
    });
  }

  async rfqAddendum(vendorIds: string[], number: string, title: string, text: string, deadline: Date | null): Promise<void> {
    const details: [string, string][] = [['Request', number === '' ? title : `${number} · ${title}`]];
    if (deadline !== null) details.push(['New deadline', `${deadline.toISOString().replace('T', ' ').slice(0, 16)  } UTC`]);
    await this.eachVendor(vendorIds, async (_id, addresses) => {
      await this.send(addresses, `Update to ${number === '' ? title : number}`, { heading: 'An update to a request you were invited to', body: text, cta: 'Open the request', path: '/vendor/rfqs', details }, 'vendor');
    });
  }

  async rfqClosed(vendorIds: string[], number: string, title: string, reason: string): Promise<void> {
    await this.eachVendor(vendorIds, async (_id, addresses) => {
      await this.send(addresses, `${number} is closed`, { heading: `${title} is closed to new quotes`, body: `The buyer closed this request early: ${reason}`, cta: 'Open the request', path: '/vendor/rfqs', details: [['Request', number]] }, 'vendor');
    });
  }

  async rfqCancelled(vendorIds: string[], number: string, title: string, reason: string): Promise<void> {
    await this.eachVendor(vendorIds, async (_id, addresses) => {
      await this.send(addresses, `${number} is cancelled`, { heading: `${title} is cancelled`, body: `The buyer cancelled this request: ${reason}`, cta: 'Open the request', path: '/vendor/rfqs', details: [['Request', number]] }, 'vendor');
    });
  }

  async rfqReminder(vendorId: string, number: string, title: string, deadline: Date, hours: number): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    await this.send(addresses, `Quotes for ${number} are due in ${String(hours)} hours`, { heading: `Quotes for ${title} are due soon`, body: 'You have not sent a quote yet. Send it before the deadline, or tell us you are not bidding.', cta: 'Open the request', path: '/vendor/rfqs', details: [['Request', number], ['Quotes are due', `${deadline.toISOString().replace('T', ' ').slice(0, 16)  } UTC`]] }, 'vendor');
  }

  async quoteReceived(vendorId: string, number: string, version: number): Promise<void> {
    const { legalName } = await this.vendorAddresses(vendorId);
    await this.send(await this.staffAddress(), `A quote came in for ${number}`, { heading: `${legalName} sent a quote`, body: `Version ${String(version)} of a quote for ${number} was received. Sealed quotes stay closed until the deadline.`, cta: 'Open the request', path: '/admin/vendors/rfqs', details: [['Request', number]] }, 'staff');
  }

  async quoteRevisionRequested(vendorId: string, number: string, title: string, comment: string, due: Date): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    await this.send(addresses, `Please revise your quote for ${number}`, { heading: `The buyer asks you to revise your quote for ${title}`, body: comment, cta: 'Revise my quote', path: '/vendor/rfqs', details: [['Request', number], ['Send the revision by', `${due.toISOString().replace('T', ' ').slice(0, 16)  } UTC`]] }, 'vendor');
  }

  async quoteRejected(vendorId: string, number: string, title: string, reason: string): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    await this.send(addresses, `Your quote for ${number} was not accepted`, { heading: `Your quote for ${title} was not accepted`, body: 'Thank you for quoting.', cta: 'See why', path: '/vendor/rfqs', details: [['Request', number], ['Reason', reason]] }, 'vendor');
  }

  async rfqResult(vendorId: string, number: string, title: string, awarded: boolean): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    await this.send(addresses, awarded ? `You were awarded ${number}` : `Result of ${number}`, {
      heading: awarded ? `You were awarded work on ${title}` : `${title} was awarded to another vendor`,
      body: awarded ? 'Congratulations. A purchase order will follow.' : 'Thank you for quoting. We do not share other vendors’ details or prices.',
      cta: 'Open the request',
      path: '/vendor/rfqs',
      details: [['Request', number]],
    }, 'vendor');
  }

  async poSent(vendorId: string, number: string, total: string, currency: string, expected: string | null): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    await this.send(addresses, `Purchase order ${number}`, {
      heading: `You have a purchase order: ${number}`,
      body: 'Open it in the vendor portal, check it, and confirm that you accept it.',
      cta: 'Open the order',
      path: '/vendor/orders',
      details: [['Order', number], ['Total', `${total} ${currency}`], ['Expected delivery', expected ?? 'to be agreed']],
    }, 'vendor');
  }

  async poAmended(vendorId: string, number: string, version: number, changes: string[], reason: string): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    await this.send(addresses, `Purchase order ${number} was changed`, {
      heading: `Purchase order ${number} was changed`,
      body: `Version ${String(version)} replaces the earlier one. Please read the changes and confirm again. Reason: ${reason}`,
      cta: 'Review and confirm',
      path: '/vendor/orders',
      details: changes.slice(0, 8).map((c, i) => [`Change ${String(i + 1)}`, c] as const),
    }, 'vendor');
  }

  async poCancelled(vendorId: string, number: string, reason: string): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId);
    await this.send(addresses, `Purchase order ${number} is cancelled`, { heading: `Purchase order ${number} is cancelled`, body: `The buyer cancelled this order: ${reason}`, cta: 'Open my orders', path: '/vendor/orders', details: [['Order', number]] }, 'vendor');
  }

  async poConfirmed(vendorId: string, number: string): Promise<void> {
    const { legalName } = await this.vendorAddresses(vendorId);
    await this.send(await this.staffAddress(), `${legalName} confirmed ${number}`, { heading: `${legalName} confirmed purchase order ${number}`, body: 'The vendor accepted the order.', cta: 'Open the order', path: '/admin/vendors/orders', details: [['Order', number]] }, 'staff');
  }

  async advanceApproved(vendorId: string, number: string, amount: string, currency: string): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId, 'finance');
    await this.send(addresses, `Advance payment approved for ${number}`, { heading: `An advance payment was approved for order ${number}`, body: 'It will be paid into your bank account on record. You will get a remittance when it is paid.', cta: 'Open the order', path: '/vendor/orders', details: [['Order', number], ['Advance', `${amount} ${currency}`]] }, 'vendor');
  }
  async invoiceSubmitted(vendorId: string, number: string): Promise<void> {
    const { legalName } = await this.vendorAddresses(vendorId);
    await this.send(await this.staffAddress(), `${legalName} sent invoice ${number}`, { heading: `${legalName} sent a supplier invoice: ${number}`, body: 'It is waiting in the supplier invoices queue.', cta: 'Open the queue', path: '/admin/vendors/invoices', details: [['Invoice', number]] }, 'staff');
  }

  async invoiceReturned(vendorId: string, number: string, reason: string, note: string): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId, 'finance');
    await this.send(addresses, `Invoice ${number} was returned`, { heading: `Your invoice ${number} was returned`, body: 'Please correct what we ask for and send it again.', cta: 'Open the invoice', path: '/vendor/invoices', details: [['Invoice', number], ['Reason', reason], ['What to fix', note === '' ? 'See the invoice' : note]] }, 'vendor');
  }

  async invoiceRefused(vendorId: string, number: string, reason: string, note: string): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId, 'finance');
    await this.send(addresses, `Invoice ${number} was refused`, { heading: `We cannot accept invoice ${number}`, body: 'You can make a new invoice if this was a mistake.', cta: 'Open my invoices', path: '/vendor/invoices', details: [['Invoice', number], ['Reason', reason], ['Note', note === '' ? '-' : note]] }, 'vendor');
  }

  async invoiceBooked(vendorId: string, number: string, vendorNo: string, total: string, currency: string): Promise<void> {
    const { addresses } = await this.vendorAddresses(vendorId, 'finance');
    await this.send(addresses, `Invoice ${number} was approved`, { heading: `Your invoice ${vendorNo} was approved`, body: 'It has been booked for payment. You will get a remittance when it is paid.', cta: 'Open my invoices', path: '/vendor/invoices', details: [['Our number', number], ['Your number', vendorNo], ['Amount', `${total} ${currency}`]] }, 'vendor');
  }
}
