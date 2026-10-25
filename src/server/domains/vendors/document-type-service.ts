import { and, asc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { vendorDocumentTypes } from '@/server/db/drizzle/schema';
import { checkDocumentType, parseReminderDays, type DocumentTypeForm } from '@/lib/vendor-document-types';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { ProfileError } from './profile-service';

/** The documents a company asks vendors for. A type that vendors already hold is never deleted, only switched off. */
export class VendorDocumentTypeService {
  constructor(private readonly db: DrizzleDb) {}

  async list(companyId: string) {
    return await this.db.select().from(vendorDocumentTypes).where(eq(vendorDocumentTypes.companyId, companyId)).orderBy(asc(vendorDocumentTypes.sortOrder), asc(vendorDocumentTypes.name));
  }

  async save(companyId: string, id: string | null, form: DocumentTypeForm): Promise<{ id: string }> {
    const problems = checkDocumentType(form, id === null);
    if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', Object.values(problems)[0] ?? 'Check the form.', problems);
    const reminderDays = parseReminderDays(form.reminderDays) ?? [];
    const values = { name: form.name.trim(), requiredForAll: form.requiredForAll, needsExpiry: form.needsExpiry, reminderDays, blocking: form.blocking && form.needsExpiry, isActive: form.isActive };
    if (id === null) {
      try {
        const [made] = await this.db.insert(vendorDocumentTypes).values({ companyId, code: form.code.trim().toUpperCase(), ...values }).returning({ id: vendorDocumentTypes.id });
        if (made === undefined) throw new ProfileError('NOT_SAVED', 'The document type could not be saved.');
        return made;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ProfileError('DUPLICATE', 'A document type with this code already exists.', { code: 'This code is already used.' });
        throw error;
      }
    }
    const [updated] = await this.db.update(vendorDocumentTypes).set(values).where(and(eq(vendorDocumentTypes.companyId, companyId), eq(vendorDocumentTypes.id, id))).returning({ id: vendorDocumentTypes.id });
    if (updated === undefined) throw new ProfileError('NOT_FOUND', 'That document type does not exist.');
    return updated;
  }
}
