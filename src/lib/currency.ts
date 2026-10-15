import { type CurrencyConfig } from '@/types/index';

/** Display-only fallback when no currency catalog is configured. Not a data seeder. */
const FORMAT_FALLBACK_CURRENCY: CurrencyConfig = {
  code: 'KES',
  name: 'Kenyan Shilling',
  symbol: 'KSh',
  exchangeRate: 1.0,
  isBaseCurrency: true,
  decimalDigits: 0,
  symbolPosition: 'prefix',
  isEnabled: true,
  flagEmoji: '',
  updatedAt: new Date(0).toISOString(),
};

/** No built-in currency catalog — configure currencies in admin. */
export const DEFAULT_CURRENCIES: CurrencyConfig[] = [];

export function formatPriceWithCurrency(
  baseAmountKes: number,
  currency: CurrencyConfig | string = 'KES',
  customCurrencies: CurrencyConfig[] = DEFAULT_CURRENCIES,
): string {
  if (Number.isNaN(baseAmountKes)) {
    return '0';
  }

  const currConfig: CurrencyConfig =
    typeof currency === 'string'
      ? customCurrencies.find((c) => c.code.toUpperCase() === currency.toUpperCase()) ?? FORMAT_FALLBACK_CURRENCY
      : currency;

  const converted = baseAmountKes * currConfig.exchangeRate;

  const formattedNumber = converted.toLocaleString(undefined, {
    minimumFractionDigits: currConfig.decimalDigits,
    maximumFractionDigits: currConfig.decimalDigits,
  });

  if (currConfig.symbolPosition === 'suffix') {
    return `${formattedNumber} ${currConfig.symbol}`;
  }
  return `${currConfig.symbol} ${formattedNumber}`;
}
