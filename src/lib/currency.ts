import { CurrencyConfig } from '@/types/index';

export const DEFAULT_CURRENCIES: CurrencyConfig[] = [
  {
    code: 'KES',
    name: 'Kenyan Shilling',
    symbol: 'KSh',
    exchangeRate: 1.0,
    isBaseCurrency: true,
    decimalDigits: 0,
    symbolPosition: 'prefix',
    isEnabled: true,
    flagEmoji: '🇰🇪',
    updatedAt: new Date().toISOString()
  },
  {
    code: 'USD',
    name: 'US Dollar',
    symbol: '$',
    exchangeRate: 0.0077, // 1 KES ≈ $0.0077 (or $1 ≈ 130 KES)
    isBaseCurrency: false,
    decimalDigits: 2,
    symbolPosition: 'prefix',
    isEnabled: true,
    flagEmoji: '🇺🇸',
    updatedAt: new Date().toISOString()
  },
  {
    code: 'EUR',
    name: 'Euro',
    symbol: '€',
    exchangeRate: 0.0071,
    isBaseCurrency: false,
    decimalDigits: 2,
    symbolPosition: 'prefix',
    isEnabled: true,
    flagEmoji: '🇪🇺',
    updatedAt: new Date().toISOString()
  },
  {
    code: 'GBP',
    name: 'British Pound',
    symbol: '£',
    exchangeRate: 0.0061,
    isBaseCurrency: false,
    decimalDigits: 2,
    symbolPosition: 'prefix',
    isEnabled: true,
    flagEmoji: '🇬🇧',
    updatedAt: new Date().toISOString()
  },
  {
    code: 'UGX',
    name: 'Ugandan Shilling',
    symbol: 'USh',
    exchangeRate: 28.5,
    isBaseCurrency: false,
    decimalDigits: 0,
    symbolPosition: 'prefix',
    isEnabled: true,
    flagEmoji: '🇺🇬',
    updatedAt: new Date().toISOString()
  },
  {
    code: 'TZS',
    name: 'Tanzanian Shilling',
    symbol: 'TSh',
    exchangeRate: 20.0,
    isBaseCurrency: false,
    decimalDigits: 0,
    symbolPosition: 'prefix',
    isEnabled: true,
    flagEmoji: '🇹🇿',
    updatedAt: new Date().toISOString()
  },
  {
    code: 'ZAR',
    name: 'South African Rand',
    symbol: 'R',
    exchangeRate: 0.14,
    isBaseCurrency: false,
    decimalDigits: 2,
    symbolPosition: 'prefix',
    isEnabled: true,
    flagEmoji: '🇿🇦',
    updatedAt: new Date().toISOString()
  },
  {
    code: 'AED',
    name: 'UAE Dirham',
    symbol: 'AED',
    exchangeRate: 0.028,
    isBaseCurrency: false,
    decimalDigits: 2,
    symbolPosition: 'prefix',
    isEnabled: true,
    flagEmoji: '🇦🇪',
    updatedAt: new Date().toISOString()
  }
];

export function formatPriceWithCurrency(
  baseAmountKes: number,
  currency: CurrencyConfig | string = 'KES',
  customCurrencies: CurrencyConfig[] = DEFAULT_CURRENCIES
): string {
  if (baseAmountKes === undefined || baseAmountKes === null || isNaN(baseAmountKes)) {
    return '0';
  }

  const currConfig: CurrencyConfig = typeof currency === 'string'
    ? customCurrencies.find(c => c.code.toUpperCase() === currency.toUpperCase()) || DEFAULT_CURRENCIES[0]
    : currency;

  const converted = baseAmountKes * currConfig.exchangeRate;
  
  const formattedNumber = converted.toLocaleString(undefined, {
    minimumFractionDigits: currConfig.decimalDigits,
    maximumFractionDigits: currConfig.decimalDigits
  });

  if (currConfig.symbolPosition === 'suffix') {
    return `${formattedNumber} ${currConfig.symbol}`;
  }
  return `${currConfig.symbol} ${formattedNumber}`;
}
