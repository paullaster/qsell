import { acceptFilters, LookupFilterError, staticSource, type LookupSource } from '@/server/domains/lookups/runner';
import { allowedOptions, ENUM_SETTINGS, isSellingType, OPTION_WORDS, SELLING_TYPES, type EnumSetting } from './selling-documents';

const isEnum = (value: string): value is EnumSetting => (ENUM_SETTINGS as readonly string[]).includes(value);

/** The choices of one setting for one selling document type (`setting` and `type` filters), as the settings screen's pickers list them. */
const options = staticSource({
  key: 'selling-setting-options',
  permission: 'selling_settings:manage',
  items: ({ filters }) => {
    const { setting, type } = acceptFilters(filters, { setting: ENUM_SETTINGS, type: SELLING_TYPES });
    if (setting === undefined || !isEnum(setting) || type === undefined || !isSellingType(type)) throw new LookupFilterError('Unsupported filter.');
    return allowedOptions(type, setting).map((id) => ({ id, label: OPTION_WORDS[setting][id]?.label ?? id, description: OPTION_WORDS[setting][id]?.description ?? null, badge: null }));
  },
});

export const SELLING_LOOKUP_SOURCES: LookupSource[] = [options];
