import { 
  Product, 
  Category,
  TaxCategory,
  CurrencyConfig,
  CustomerAccount,
  CustomerAddress,
  InventoryLedgerEntry, 
  PaymentGatewayConfig, 
  Order, 
  OrderStatus,
  TransactionRecord, 
  ReconciliationLog, 
  UserSession 
} from '@/types/index';

// In-Memory Transactional Store with atomic operations & seed records
class PostgresStore {
  public categories: Map<string, Category> = new Map();
  public taxCategories: Map<string, TaxCategory> = new Map();
  public currencies: Map<string, CurrencyConfig> = new Map();
  public products: Map<string, Product> = new Map();
  public inventoryLedger: InventoryLedgerEntry[] = [];
  public paymentGateways: Map<string, PaymentGatewayConfig> = new Map();
  public orders: Map<string, Order> = new Map();
  public transactions: Map<string, TransactionRecord> = new Map();
  public reconciliationLogs: ReconciliationLog[] = [];
  public customers: Map<string, CustomerAccount> = new Map();
  public userSessions: Map<string, UserSession> = new Map();
  public sseClients: Set<(event: string, data: any) => void> = new Set();

  constructor() {
    this.seedInitialData();
  }

  // Subscribe SSE clients for real-time inventory updates
  public subscribeSSE(client: (event: string, data: any) => void) {
    this.sseClients.add(client);
    return () => {
      this.sseClients.delete(client);
    };
  }

  public broadcast(event: string, data: any) {
    for (const send of this.sseClients) {
      try {
        send(event, data);
      } catch (err) {
        // ignore closed
      }
    }
  }

  private seedInitialData() {
    // 0. Seed Categories
    const initialCategories: Category[] = [
      {
        id: 'cat_electronics',
        name: 'Electronics',
        slug: 'electronics',
        description: 'Laptops, Pro Workstations, Displays, and Core Computing Gear',
        isActive: true,
        displayOrder: 1,
        createdAt: new Date(Date.now() - 86400000 * 60).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'cat_audio',
        name: 'Audio',
        slug: 'audio',
        description: 'Studio Monitors, Hi-Res ANC Headphones, and DAC Amplifiers',
        isActive: true,
        displayOrder: 2,
        createdAt: new Date(Date.now() - 86400000 * 60).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'cat_phones',
        name: 'Phones',
        slug: 'phones',
        description: 'Flagship Smartphones, 5G Modems, and Mobile Power Solutions',
        isActive: true,
        displayOrder: 3,
        createdAt: new Date(Date.now() - 86400000 * 60).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'cat_wearables',
        name: 'Wearables',
        slug: 'wearables',
        description: 'GPS Multisport Watches, Smart Rings, and Health Monitors',
        isActive: true,
        displayOrder: 4,
        createdAt: new Date(Date.now() - 86400000 * 60).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'cat_drones_cameras',
        name: 'Drones & Cameras',
        slug: 'drones-cameras',
        description: '4K Cinema Drones, Mirrorless Cameras, and Stabilized Gimbals',
        isActive: true,
        displayOrder: 5,
        createdAt: new Date(Date.now() - 86400000 * 60).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'cat_accessories',
        name: 'Accessories',
        slug: 'accessories',
        description: 'GaN Chargers, Thunderbolt Cables, Ergonomic Stands & Hubs',
        isActive: true,
        displayOrder: 6,
        createdAt: new Date(Date.now() - 86400000 * 60).toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    for (const cat of initialCategories) {
      this.categories.set(cat.id, cat);
    }

    // 0.1 Seed Global & Regional Tax Categories
    const initialTaxes: TaxCategory[] = [
      {
        id: 'tax_kra_vat_16',
        name: 'Standard VAT (16% Kenya KRA)',
        code: 'VAT_16',
        rate: 16.0,
        type: 'vat',
        countryCode: 'KE',
        countryName: 'Kenya',
        description: 'Standard 16% Value Added Tax on consumer goods and electronics under KRA eTIMS regulations.',
        isInclusive: true,
        isDefault: true,
        isActive: true,
        createdAt: new Date(Date.now() - 86400000 * 90).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'tax_zero_rated',
        name: 'Zero Rated (0% KRA Schedule 1)',
        code: 'ZERO_0',
        rate: 0.0,
        type: 'exempt',
        countryCode: 'KE',
        countryName: 'Kenya',
        description: '0% Tax Rate on qualifying educational, assistive technology, and export supplies.',
        isInclusive: true,
        isDefault: false,
        isActive: true,
        createdAt: new Date(Date.now() - 86400000 * 90).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'tax_exempt',
        name: 'Exempt Supplies (KRA Schedule 2)',
        code: 'EXEMPT',
        rate: 0.0,
        type: 'exempt',
        countryCode: 'KE',
        countryName: 'Kenya',
        description: 'Fully exempt supplies not subject to VAT deduction or levy.',
        isInclusive: true,
        isDefault: false,
        isActive: true,
        createdAt: new Date(Date.now() - 86400000 * 90).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'tax_dst_1_5',
        name: 'Digital Services Tax (1.5% e-Commerce)',
        code: 'DST_1_5',
        rate: 1.5,
        type: 'digital_service',
        countryCode: 'KE',
        countryName: 'Kenya',
        description: 'Digital Marketplace and Electronic Services levy on cross-border merchant platforms.',
        isInclusive: true,
        isDefault: false,
        isActive: true,
        createdAt: new Date(Date.now() - 86400000 * 80).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'tax_reduced_8',
        name: 'Reduced Rate / Petroleum & Energy (8%)',
        code: 'REDUCED_8',
        rate: 8.0,
        type: 'vat',
        countryCode: 'KE',
        countryName: 'Kenya',
        description: 'Special reduced VAT rate applicable to qualifying energy supplies and green hardware.',
        isInclusive: true,
        isDefault: false,
        isActive: true,
        createdAt: new Date(Date.now() - 86400000 * 70).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'tax_us_sales_8_25',
        name: 'US Standard Sales Tax (8.25% Cross-Border)',
        code: 'US_SALES_8_25',
        rate: 8.25,
        type: 'sales_tax',
        countryCode: 'US',
        countryName: 'United States',
        description: 'State & Local benchmark sales tax rate for North American international export orders.',
        isInclusive: false,
        isDefault: false,
        isActive: true,
        createdAt: new Date(Date.now() - 86400000 * 60).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'tax_eu_vat_20',
        name: 'EU Standard VAT (20% Cross-Border)',
        code: 'EU_VAT_20',
        rate: 20.0,
        type: 'vat',
        countryCode: 'EU',
        countryName: 'European Union',
        description: 'European Union one-stop-shop (OSS) standard VAT benchmark for European exports.',
        isInclusive: false,
        isDefault: false,
        isActive: true,
        createdAt: new Date(Date.now() - 86400000 * 50).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'tax_gcc_vat_5',
        name: 'GCC UAE Standard VAT (5%)',
        code: 'GCC_VAT_5',
        rate: 5.0,
        type: 'vat',
        countryCode: 'AE',
        countryName: 'United Arab Emirates / GCC',
        description: 'Federal Tax Authority (FTA) 5% VAT rate for UAE and Middle East export consignments.',
        isInclusive: true,
        isDefault: false,
        isActive: true,
        createdAt: new Date(Date.now() - 86400000 * 40).toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    for (const tax of initialTaxes) {
      this.taxCategories.set(tax.id, tax);
    }

    // 0.2 Seed Multi-Market Currencies
    const initialCurrencies: CurrencyConfig[] = [
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
        exchangeRate: 0.0077,
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

    for (const cur of initialCurrencies) {
      this.currencies.set(cur.code, cur);
    }

    // 1. Payment Gateways
    const mpesaGateway: PaymentGatewayConfig = {
      id: 'gw_mpesa_daraja',
      provider: 'mpesa_daraja',
      name: 'M-Pesa Express (Daraja STK Push)',
      isEnabled: true,
      environment: 'sandbox',
      credentials: {
        consumerKey: 'cNd3A8vK4jQ1LzX9wE2rP6yT7uI5oM0s',
        consumerSecret: '9vK4jQ1LzX9wE2rP6yT7uI5oM0scNd3A8',
        shortcode: '174379',
        passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
        accountReference: 'OMNICOMMERCE',
      },
      supportedCurrencies: ['KES'],
      icon: 'smartphone',
      description: 'Instant Mobile Money STK Prompt via Safaricom Daraja 2.0 API'
    };

    const pesapalGateway: PaymentGatewayConfig = {
      id: 'gw_pesapal_v3',
      provider: 'pesapal_v3',
      name: 'Pesapal v3 (Card, Bank & Mobile)',
      isEnabled: true,
      environment: 'sandbox',
      credentials: {
        consumerKey: 'qk1sv5F5Xk9876ZxcVbN0123456789aA',
        consumerSecret: 'pEsApAlSeCrEt_v3_9876543210',
        ipnId: 'ipn_88fa7b49-21dc-49ef-941f-cb70f90c7932',
      },
      supportedCurrencies: ['KES', 'USD'],
      icon: 'credit-card',
      description: 'Visa, Mastercard, Airtel Money & Direct Bank Transfer via Pesapal v3.0'
    };

    const cardGateway: PaymentGatewayConfig = {
      id: 'gw_card_direct',
      provider: 'card_direct',
      name: 'Direct Card Checkout (3D Secure)',
      isEnabled: true,
      environment: 'sandbox',
      credentials: {
        consumerKey: 'pk_test_direct_card_9941a8',
      },
      supportedCurrencies: ['KES', 'USD'],
      icon: 'shield-check',
      description: 'Instant 3DS2 Compliant Visa / Mastercard processing'
    };

    this.paymentGateways.set(mpesaGateway.id, mpesaGateway);
    this.paymentGateways.set(pesapalGateway.id, pesapalGateway);
    this.paymentGateways.set(cardGateway.id, cardGateway);

    // 2. Initial Products Catalog with accurate KES pricing and inventory
    const initialProducts: Product[] = [
      {
        id: 'prod_101',
        sku: 'APL-MBP16-M3M',
        name: 'MacBook Pro 16" M3 Max (36GB / 1TB SSD)',
        slug: 'macbook-pro-16-m3-max',
        description: 'Engineered for extreme pro workflows. Featuring the powerful 14-core CPU, 30-core GPU Apple Silicon chip, Liquid Retina XDR display with ProMotion 120Hz.',
        category: 'Electronics',
        price: 435000,
        compareAtPrice: 475000,
        stockQuantity: 14,
        reservedQuantity: 1,
        lowStockThreshold: 4,
        isActive: true,
        imageUrl: 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=1000&q=80',
        rating: 4.9,
        reviewCount: 38,
        tags: ['Apple', 'Laptops', 'Pro Workstations', 'M3 Max'],
        createdAt: new Date(Date.now() - 86400000 * 30).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'prod_102',
        sku: 'SNY-WH1000XM5-BLK',
        name: 'Sony WH-1000XM5 Noise-Cancelling Headphones',
        slug: 'sony-wh-1000xm5-black',
        description: 'Industry-leading noise canceling with two processors and 8 microphones. Crystal clear hands-free calling with 4 beamforming microphones and LDAC high-res audio.',
        category: 'Audio',
        price: 48500,
        compareAtPrice: 56000,
        stockQuantity: 28,
        reservedQuantity: 2,
        lowStockThreshold: 5,
        isActive: true,
        imageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=1000&q=80',
        rating: 4.8,
        reviewCount: 94,
        tags: ['Sony', 'Wireless', 'ANC', 'Hi-Res'],
        createdAt: new Date(Date.now() - 86400000 * 25).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'prod_103',
        sku: 'SMG-S24U-512GB-TI',
        name: 'Samsung Galaxy S24 Ultra 512GB Titanium Gray',
        slug: 'samsung-galaxy-s24-ultra-512gb',
        description: 'Welcome to the era of Galaxy AI. Meet the 200MP camera, Snapdragon 8 Gen 3 for Galaxy, titanium frame, and built-in S Pen.',
        category: 'Phones',
        price: 184000,
        compareAtPrice: 205000,
        stockQuantity: 9,
        reservedQuantity: 0,
        lowStockThreshold: 5,
        isActive: true,
        imageUrl: 'https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?auto=format&fit=crop&w=1000&q=80',
        rating: 4.9,
        reviewCount: 67,
        tags: ['Samsung', '5G', 'Galaxy AI', 'Smartphones'],
        createdAt: new Date(Date.now() - 86400000 * 20).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'prod_104',
        sku: 'GAR-EPIX-PRO-51MM',
        name: 'Garmin Epix Pro Gen 2 Sapphire 51mm Smartwatch',
        slug: 'garmin-epix-pro-gen-2-sapphire',
        description: 'Premium multisport GPS smartwatch with stunning AMOLED display, built-in LED flashlight, endurance score, and up to 31 days battery life in smartwatch mode.',
        category: 'Wearables',
        price: 138000,
        compareAtPrice: 155000,
        stockQuantity: 3, // Low stock on purpose
        reservedQuantity: 1,
        lowStockThreshold: 5,
        isActive: true,
        imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=1000&q=80',
        rating: 4.9,
        reviewCount: 42,
        tags: ['Garmin', 'Fitness', 'GPS', 'Smartwatch', 'Outdoor'],
        createdAt: new Date(Date.now() - 86400000 * 18).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'prod_105',
        sku: 'DJI-MAV3-PRO-CINE',
        name: 'DJI Mavic 3 Pro Cine Drone with RC Pro Remote',
        slug: 'dji-mavic-3-pro-cine',
        description: 'Triple-camera flagship system with 4/3 CMOS Hasselblad camera, dual telephoto cameras, 43-min flight time, and Apple ProRes 422 HQ recording.',
        category: 'Drones & Cameras',
        price: 520000,
        compareAtPrice: 560000,
        stockQuantity: 6,
        reservedQuantity: 0,
        lowStockThreshold: 2,
        isActive: true,
        imageUrl: 'https://images.unsplash.com/photo-1527977966376-1c8408f9f108?auto=format&fit=crop&w=1000&q=80',
        rating: 5.0,
        reviewCount: 19,
        tags: ['DJI', 'Drones', '4K Video', 'Pro Photography'],
        createdAt: new Date(Date.now() - 86400000 * 15).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'prod_106',
        sku: 'KYC-MECH-RGB-K3',
        name: 'Keychron Q3 Max Custom Wireless Mechanical Keyboard',
        slug: 'keychron-q3-max-custom-wireless',
        description: 'Full CNC aluminum body, double-gasket design, 2.4 GHz wireless & Bluetooth 5.1, hot-swappable Gateron Jupiter switches, and acoustic foam padding.',
        category: 'Accessories',
        price: 26500,
        compareAtPrice: 32000,
        stockQuantity: 35,
        reservedQuantity: 0,
        lowStockThreshold: 8,
        isActive: true,
        imageUrl: 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=1000&q=80',
        rating: 4.7,
        reviewCount: 81,
        tags: ['Keychron', 'Mechanical Keyboard', 'Workstation', 'Custom'],
        createdAt: new Date(Date.now() - 86400000 * 12).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'prod_107',
        sku: 'BOS-SND-REV-PLUS',
        name: 'Bose SoundLink Max Portable Bluetooth Speaker',
        slug: 'bose-soundlink-max-portable-speaker',
        description: 'Epic stereo sound, deep bass, removable soft rope handle, IP67 waterproof and dustproof, up to 20 hours battery life on a single charge.',
        category: 'Audio',
        price: 54000,
        compareAtPrice: 62000,
        stockQuantity: 19,
        reservedQuantity: 0,
        lowStockThreshold: 5,
        isActive: true,
        imageUrl: 'https://images.unsplash.com/photo-1545454675-3531b543be5d?auto=format&fit=crop&w=1000&q=80',
        rating: 4.8,
        reviewCount: 52,
        tags: ['Bose', 'Bluetooth', 'Outdoor', 'Bass'],
        createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'prod_108',
        sku: 'ANK-737-PWRBK-24K',
        name: 'Anker Prime 24,000mAh Power Bank (140W GaN 3-Port)',
        slug: 'anker-prime-24000mah-power-bank',
        description: 'Ultra-powerful 140W two-way fast charging with Smart Digital Display, charges a 16" MacBook Pro to 50% in just 40 minutes.',
        category: 'Accessories',
        price: 19500,
        compareAtPrice: 24000,
        stockQuantity: 2, // Low stock on purpose
        reservedQuantity: 0,
        lowStockThreshold: 6,
        isActive: true,
        imageUrl: 'https://images.unsplash.com/photo-1609081219090-a6d81d3085bf?auto=format&fit=crop&w=1000&q=80',
        rating: 4.9,
        reviewCount: 110,
        tags: ['Anker', 'PowerBank', 'USB-C', 'Fast Charging'],
        createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    for (const prod of initialProducts) {
      this.products.set(prod.id, prod);
      // Seed initial ledger
      this.inventoryLedger.push({
        id: `ledger_${prod.id}_init`,
        productId: prod.id,
        productName: prod.name,
        changeAmount: prod.stockQuantity,
        previousStock: 0,
        newStock: prod.stockQuantity,
        changeType: 'restock',
        referenceId: 'INITIAL_IMPORT_PO_001',
        actor: 'system_admin',
        note: 'Initial catalog stock import to PostgreSQL storage',
        timestamp: new Date(Date.now() - 86400000 * 7).toISOString()
      });
    }

    // 3. Seed Existing Orders with M-Pesa & Pesapal
    const sampleOrder1: Order = {
      id: 'ord_9901',
      orderNumber: 'ORD-2026-8801',
      userId: 'usr_paullaster',
      customerName: 'Paul Laster Okoth',
      customerEmail: 'paullasterokoth98@gmail.com',
      customerPhone: '254712345678',
      shippingAddress: {
        street: 'Riverside Drive, Delta Corner Suite 4A',
        city: 'Nairobi',
        countyOrState: 'Nairobi County',
        postalCode: '00100',
        country: 'Kenya'
      },
      items: [
        {
          productId: 'prod_102',
          productName: 'Sony WH-1000XM5 Noise-Cancelling Headphones',
          sku: 'SNY-WH1000XM5-BLK',
          quantity: 1,
          unitPrice: 48500,
          totalPrice: 48500,
          imageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=1000&q=80'
        }
      ],
      subtotal: 48500,
      tax: 7760,
      shippingFee: 0,
      totalAmount: 56260,
      currency: 'KES',
      status: 'completed',
      paymentStatus: 'reconciled',
      paymentMethod: 'mpesa_daraja',
      transactionReference: 'ws_CO_01092026114532890',
      mpesaReceiptNumber: 'SHK7892KLM',
      createdAt: new Date(Date.now() - 3600000 * 5).toISOString(),
      updatedAt: new Date(Date.now() - 3600000 * 5).toISOString()
    };

    const sampleOrder2: Order = {
      id: 'ord_9902',
      orderNumber: 'ORD-2026-8802',
      userId: 'usr_jane_wambui',
      customerName: 'Jane Wambui',
      customerEmail: 'jane.wambui@techhub.co.ke',
      customerPhone: '254722998877',
      shippingAddress: {
        street: 'Kilimani, Wood Avenue Apt 12',
        city: 'Nairobi',
        countyOrState: 'Nairobi County',
        postalCode: '00100',
        country: 'Kenya'
      },
      items: [
        {
          productId: 'prod_106',
          productName: 'Keychron Q3 Max Custom Wireless Mechanical Keyboard',
          sku: 'KYC-MECH-RGB-K3',
          quantity: 2,
          unitPrice: 26500,
          totalPrice: 53000,
          imageUrl: 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=1000&q=80'
        }
      ],
      subtotal: 53000,
      tax: 8480,
      shippingFee: 500,
      totalAmount: 61980,
      currency: 'KES',
      status: 'processing',
      paymentStatus: 'reconciled',
      paymentMethod: 'pesapal_v3',
      transactionReference: 'pesa_ref_9921_bc401',
      pesapalTrackingId: '7f91a0c4-9876-412e-901a-88bcfe231011',
      createdAt: new Date(Date.now() - 3600000 * 2).toISOString(),
      updatedAt: new Date(Date.now() - 3600000 * 2).toISOString()
    };

    this.orders.set(sampleOrder1.id, sampleOrder1);
    this.orders.set(sampleOrder2.id, sampleOrder2);

    // 4. Seed Transactions
    const tx1: TransactionRecord = {
      id: 'tx_001_mpesa',
      orderId: sampleOrder1.id,
      orderNumber: sampleOrder1.orderNumber,
      gatewayProvider: 'mpesa_daraja',
      transactionReference: 'ws_CO_01092026114532890',
      externalReference: 'SHK7892KLM',
      amount: 56260,
      currency: 'KES',
      status: 'successful',
      customerPhone: '254712345678',
      requestPayload: {
        BusinessShortCode: '174379',
        TransactionType: 'CustomerPayBillOnline',
        Amount: 56260,
        PartyA: '254712345678',
        PartyB: '174379',
        PhoneNumber: '254712345678',
        CallBackURL: 'https://omnicommerce.ke/api/payments/daraja/callback',
        AccountReference: 'ORD-2026-8801'
      },
      responsePayload: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: 'ws_CO_01092026114532890',
        ResponseCode: '0',
        ResponseDescription: 'Success. Request accepted for processing',
        CustomerMessage: 'Success. Request accepted for processing'
      },
      ipnStatus: 'delivered',
      reconciliationStatus: 'reconciled',
      createdAt: sampleOrder1.createdAt,
      updatedAt: sampleOrder1.updatedAt
    };

    const tx2: TransactionRecord = {
      id: 'tx_002_pesapal',
      orderId: sampleOrder2.id,
      orderNumber: sampleOrder2.orderNumber,
      gatewayProvider: 'pesapal_v3',
      transactionReference: 'pesa_ref_9921_bc401',
      externalReference: '7f91a0c4-9876-412e-901a-88bcfe231011',
      amount: 61980,
      currency: 'KES',
      status: 'successful',
      customerEmail: sampleOrder2.customerEmail,
      requestPayload: {
        id: 'pesa_ref_9921_bc401',
        currency: 'KES',
        amount: 61980,
        description: 'OmniCommerce Order ORD-2026-8802',
        callback_url: 'https://omnicommerce.ke/api/payments/pesapal/ipn',
        billing_address: sampleOrder2.shippingAddress
      },
      responsePayload: {
        order_tracking_id: '7f91a0c4-9876-412e-901a-88bcfe231011',
        merchant_reference: 'pesa_ref_9921_bc401',
        redirect_url: 'https://cybqa.pesapal.com/pesapalv3/api/Payment/Redirect?orderTrackingId=7f91a0c4',
        status: '200'
      },
      ipnStatus: 'delivered',
      reconciliationStatus: 'reconciled',
      createdAt: sampleOrder2.createdAt,
      updatedAt: sampleOrder2.updatedAt
    };

    this.transactions.set(tx1.id, tx1);
    this.transactions.set(tx2.id, tx2);

    // 5. Seed Reconciliation Logs
    this.reconciliationLogs.push({
      id: 'recon_001',
      transactionId: tx1.id,
      orderId: sampleOrder1.id,
      orderNumber: sampleOrder1.orderNumber,
      provider: 'mpesa_daraja',
      reconciliationType: 'auto_realtime',
      orderTotal: 56260,
      receivedAmount: 56260,
      discrepancyFound: false,
      discrepancyType: 'none',
      status: 'matched',
      details: 'Instant M-Pesa IPN matched order ORD-2026-8801 total (KES 56,260.00) perfectly with Daraja LNMO receipt SHK7892KLM.',
      timestamp: sampleOrder1.updatedAt
    });

    // 5.1 Seed Additional Historical Order for Paul Laster Okoth
    const sampleOrder0: Order = {
      id: 'ord_9899',
      orderNumber: 'ORD-2026-8790',
      userId: 'usr_paullaster',
      customerName: 'Paul Laster Okoth',
      customerEmail: 'paullasterokoth98@gmail.com',
      customerPhone: '254712345678',
      shippingAddress: {
        street: 'Riverside Drive, Delta Corner Suite 4A',
        city: 'Nairobi',
        countyOrState: 'Nairobi County',
        postalCode: '00100',
        country: 'Kenya'
      },
      items: [
        {
          productId: 'prod_101',
          productName: 'Apple MacBook Pro 16" (M3 Max, 36GB, 1TB SSD)',
          sku: 'APL-MBP16-M3MAX',
          quantity: 1,
          unitPrice: 420000,
          totalPrice: 420000,
          imageUrl: 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=1000&q=80'
        }
      ],
      subtotal: 420000,
      tax: 67200,
      shippingFee: 0,
      totalAmount: 487200,
      currency: 'KES',
      status: 'delivered',
      paymentStatus: 'reconciled',
      paymentMethod: 'mpesa_daraja',
      transactionReference: 'ws_CO_28082026093012111',
      mpesaReceiptNumber: 'SGL9821XYZ',
      shippingCourier: 'Fargo Courier Kenya',
      trackingNumber: 'FRG-NBO-882910',
      deliveredAt: new Date(Date.now() - 86400000 * 3).toISOString(),
      shippedAt: new Date(Date.now() - 86400000 * 4).toISOString(),
      createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
      updatedAt: new Date(Date.now() - 86400000 * 3).toISOString()
    };

    this.orders.set(sampleOrder0.id, sampleOrder0);

    // 6. Seed Operational Customer Accounts
    const initialCustomers: CustomerAccount[] = [
      {
        id: 'usr_paullaster',
        name: 'Paul Laster Okoth',
        email: 'paullasterokoth98@gmail.com',
        phone: '0712345678',
        role: 'customer',
        status: 'verified',
        addresses: [
          {
            id: 'addr_paul_01',
            label: 'Office (Delta Corner)',
            recipientName: 'Paul Laster Okoth',
            recipientPhone: '0712345678',
            street: 'Riverside Drive, Delta Corner Suite 4A',
            city: 'Nairobi',
            countyOrState: 'Nairobi County',
            postalCode: '00100',
            country: 'Kenya',
            isDefault: true
          },
          {
            id: 'addr_paul_02',
            label: 'Home Residence',
            recipientName: 'Paul Laster Okoth',
            recipientPhone: '0712345678',
            street: 'Kilimani, Wood Avenue Court B-4',
            city: 'Nairobi',
            countyOrState: 'Nairobi County',
            postalCode: '00100',
            country: 'Kenya',
            isDefault: false
          }
        ],
        paymentPreferences: {
          preferredMethod: 'mpesa_daraja',
          defaultMpesaPhone: '254712345678'
        },
        totalOrders: 2,
        totalSpend: 543460,
        lastOrderDate: sampleOrder1.createdAt,
        createdAt: new Date(Date.now() - 86400000 * 30).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'usr_jane_wambui',
        name: 'Jane Wambui',
        email: 'jane.wambui@techhub.co.ke',
        phone: '254722998877',
        role: 'customer',
        status: 'verified',
        addresses: [
          {
            id: 'addr_jane_01',
            label: 'Tech Hub Office',
            recipientName: 'Jane Wambui',
            recipientPhone: '254722998877',
            street: 'Kilimani, Wood Avenue Apt 12',
            city: 'Nairobi',
            countyOrState: 'Nairobi County',
            postalCode: '00100',
            country: 'Kenya',
            isDefault: true
          }
        ],
        paymentPreferences: {
          preferredMethod: 'pesapal_v3',
          defaultCardLast4: '4242'
        },
        totalOrders: 1,
        totalSpend: 61980,
        lastOrderDate: sampleOrder2.createdAt,
        createdAt: new Date(Date.now() - 86400000 * 20).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'usr_faith_wanjiku',
        name: 'Faith Wanjiku Mwangi',
        email: 'faith.wanjiku@kenyabiz.co.ke',
        phone: '0722998877',
        role: 'customer',
        status: 'verified',
        addresses: [
          {
            id: 'addr_faith_01',
            label: 'HQ Sameer Park',
            recipientName: 'Faith Wanjiku Mwangi',
            recipientPhone: '0722998877',
            street: 'Mombasa Road, Sameer Business Park Block C',
            city: 'Nairobi',
            countyOrState: 'Nairobi County',
            postalCode: '00100',
            country: 'Kenya',
            isDefault: true
          }
        ],
        paymentPreferences: {
          preferredMethod: 'mpesa_daraja',
          defaultMpesaPhone: '254722998877'
        },
        totalOrders: 3,
        totalSpend: 285000,
        lastOrderDate: new Date(Date.now() - 86400000 * 2).toISOString(),
        createdAt: new Date(Date.now() - 86400000 * 45).toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'usr_brian_kiprop',
        name: 'Brian Kiprop',
        email: 'brian.kiprop@eldoretinnovations.com',
        phone: '0701443322',
        role: 'customer',
        status: 'active',
        addresses: [
          {
            id: 'addr_brian_01',
            label: 'Eldoret Tech Campus',
            recipientName: 'Brian Kiprop',
            recipientPhone: '0701443322',
            street: 'Uganda Road, Rupa Mills Mall 2nd Floor',
            city: 'Eldoret',
            countyOrState: 'Uasin Gishu County',
            postalCode: '30100',
            country: 'Kenya',
            isDefault: true
          }
        ],
        paymentPreferences: {
          preferredMethod: 'mpesa_daraja',
          defaultMpesaPhone: '254701443322'
        },
        totalOrders: 1,
        totalSpend: 84900,
        lastOrderDate: new Date(Date.now() - 86400000 * 4).toISOString(),
        createdAt: new Date(Date.now() - 86400000 * 15).toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    for (const customer of initialCustomers) {
      this.customers.set(customer.id, customer);
    }
  }

  // ==========================================================================
  // Customer Account & Address Book Operations
  // ==========================================================================
  public getAllCustomers(): CustomerAccount[] {
    return Array.from(this.customers.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  public getCustomerById(id: string): CustomerAccount | null {
    return this.customers.get(id) || null;
  }

  public getCustomerByEmailOrPhone(query: string): CustomerAccount | null {
    if (!query) return null;
    const clean = query.trim().toLowerCase();
    const phoneClean = query.replace(/\D/g, '');

    for (const cust of this.customers.values()) {
      if (cust.email.toLowerCase() === clean) return cust;
      if (cust.id.toLowerCase() === clean) return cust;
      const custPhone = cust.phone.replace(/\D/g, '');
      if (custPhone && phoneClean && (custPhone.includes(phoneClean) || phoneClean.includes(custPhone))) {
        return cust;
      }
    }
    return null;
  }

  public createCustomer(data: Partial<CustomerAccount>): CustomerAccount {
    const id = data.id || `usr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();

    const customer: CustomerAccount = {
      id,
      name: data.name || 'New Customer',
      email: data.email || `customer_${Date.now()}@example.com`,
      phone: data.phone || '0700000000',
      avatarUrl: data.avatarUrl,
      role: data.role || 'customer',
      status: data.status || 'verified',
      addresses: data.addresses || [],
      paymentPreferences: data.paymentPreferences || {
        preferredMethod: 'mpesa_daraja',
        defaultMpesaPhone: data.phone || '254700000000'
      },
      totalOrders: data.totalOrders || 0,
      totalSpend: data.totalSpend || 0,
      lastOrderDate: data.lastOrderDate,
      createdAt: now,
      updatedAt: now
    };

    this.customers.set(id, customer);
    this.broadcast('customer_created', customer);
    return customer;
  }

  public updateCustomer(id: string, updates: Partial<CustomerAccount>): CustomerAccount {
    const customer = this.customers.get(id);
    if (!customer) {
      throw new Error(`Customer with ID ${id} not found`);
    }

    const updated: CustomerAccount = {
      ...customer,
      ...updates,
      paymentPreferences: {
        ...customer.paymentPreferences,
        ...(updates.paymentPreferences || {})
      },
      updatedAt: new Date().toISOString()
    };

    this.customers.set(id, updated);
    this.broadcast('customer_updated', updated);
    return updated;
  }

  public addCustomerAddress(customerId: string, addressData: Omit<CustomerAddress, 'id'>): CustomerAddress {
    const customer = this.customers.get(customerId);
    if (!customer) {
      throw new Error(`Customer with ID ${customerId} not found`);
    }

    const addressId = `addr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const isFirst = customer.addresses.length === 0;
    const isDefault = addressData.isDefault || isFirst;

    if (isDefault) {
      customer.addresses.forEach(a => { a.isDefault = false; });
    }

    const newAddress: CustomerAddress = {
      ...addressData,
      id: addressId,
      isDefault
    };

    customer.addresses.push(newAddress);
    customer.updatedAt = new Date().toISOString();
    this.broadcast('customer_updated', customer);
    return newAddress;
  }

  public updateCustomerAddress(customerId: string, addressId: string, updates: Partial<CustomerAddress>): CustomerAddress {
    const customer = this.customers.get(customerId);
    if (!customer) {
      throw new Error(`Customer with ID ${customerId} not found`);
    }

    const idx = customer.addresses.findIndex(a => a.id === addressId);
    if (idx === -1) {
      throw new Error(`Address ${addressId} not found for customer ${customerId}`);
    }

    if (updates.isDefault) {
      customer.addresses.forEach(a => { a.isDefault = false; });
    }

    const existing = customer.addresses[idx];
    const updated: CustomerAddress = {
      ...existing,
      ...updates
    };

    customer.addresses[idx] = updated;
    customer.updatedAt = new Date().toISOString();
    this.broadcast('customer_updated', customer);
    return updated;
  }

  public deleteCustomerAddress(customerId: string, addressId: string): boolean {
    const customer = this.customers.get(customerId);
    if (!customer) return false;

    const initialLen = customer.addresses.length;
    customer.addresses = customer.addresses.filter(a => a.id !== addressId);

    if (customer.addresses.length < initialLen) {
      if (customer.addresses.length > 0 && !customer.addresses.some(a => a.isDefault)) {
        customer.addresses[0].isDefault = true;
      }
      customer.updatedAt = new Date().toISOString();
      this.broadcast('customer_updated', customer);
      return true;
    }
    return false;
  }

  public setDefaultAddress(customerId: string, addressId: string): CustomerAccount {
    const customer = this.customers.get(customerId);
    if (!customer) {
      throw new Error(`Customer with ID ${customerId} not found`);
    }

    customer.addresses.forEach(a => {
      a.isDefault = a.id === addressId;
    });

    customer.updatedAt = new Date().toISOString();
    this.broadcast('customer_updated', customer);
    return customer;
  }

  public getCustomerOrders(customerIdOrEmail: string): Order[] {
    const clean = customerIdOrEmail.toLowerCase().trim();
    return Array.from(this.orders.values())
      .filter(o => 
        (o.userId && o.userId.toLowerCase() === clean) || 
        (o.customerEmail && o.customerEmail.toLowerCase() === clean)
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // Transactional Atomic Inventory Reservation
  public atomicReserveStock(items: { productId: string; quantity: number }[], orderId: string, actor: string = 'customer_checkout'): { success: boolean; error?: string } {
    // 1. Validate all items exist and have sufficient available stock (stockQuantity - reservedQuantity)
    for (const item of items) {
      const prod = this.products.get(item.productId);
      if (!prod) {
        return { success: false, error: `Product ID ${item.productId} was not found in catalog.` };
      }
      const available = prod.stockQuantity - prod.reservedQuantity;
      if (available < item.quantity) {
        return { 
          success: false, 
          error: `Insufficient inventory for "${prod.name}". Available: ${available}, Requested: ${item.quantity}.` 
        };
      }
    }

    // 2. Perform atomic reservation
    for (const item of items) {
      const prod = this.products.get(item.productId)!;
      prod.reservedQuantity += item.quantity;
      prod.updatedAt = new Date().toISOString();

      this.inventoryLedger.push({
        id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        productId: prod.id,
        productName: prod.name,
        changeAmount: -item.quantity,
        previousStock: prod.stockQuantity,
        newStock: prod.stockQuantity - prod.reservedQuantity,
        changeType: 'order_reservation',
        referenceId: orderId,
        actor,
        note: `Reserved ${item.quantity} units for pending order ${orderId}`,
        timestamp: new Date().toISOString()
      });
    }

    // Broadcast inventory change
    this.broadcast('inventory_update', {
      type: 'reservation',
      orderId,
      products: Array.from(this.products.values())
    });

    return { success: true };
  }

  // Transactional Inventory Fulfillment on Payment Success
  public atomicFulfillStock(items: { productId: string; quantity: number }[], orderId: string): void {
    for (const item of items) {
      const prod = this.products.get(item.productId);
      if (prod) {
        const prevStock = prod.stockQuantity;
        prod.stockQuantity = Math.max(0, prod.stockQuantity - item.quantity);
        prod.reservedQuantity = Math.max(0, prod.reservedQuantity - item.quantity);
        prod.updatedAt = new Date().toISOString();

        this.inventoryLedger.push({
          id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          productId: prod.id,
          productName: prod.name,
          changeAmount: -item.quantity,
          previousStock: prevStock,
          newStock: prod.stockQuantity,
          changeType: 'order_fulfillment',
          referenceId: orderId,
          actor: 'payment_reconciliation_engine',
          note: `Fulfilled and finalized stock deduction of ${item.quantity} units for order ${orderId}`,
          timestamp: new Date().toISOString()
        });
      }
    }

    this.broadcast('inventory_update', {
      type: 'fulfillment',
      orderId,
      products: Array.from(this.products.values())
    });
  }

  // Release stock if payment fails or expires
  public atomicReleaseReservation(items: { productId: string; quantity: number }[], orderId: string): void {
    for (const item of items) {
      const prod = this.products.get(item.productId);
      if (prod) {
        prod.reservedQuantity = Math.max(0, prod.reservedQuantity - item.quantity);
        prod.updatedAt = new Date().toISOString();

        this.inventoryLedger.push({
          id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          productId: prod.id,
          productName: prod.name,
          changeAmount: item.quantity,
          previousStock: prod.stockQuantity,
          newStock: prod.stockQuantity,
          changeType: 'order_cancellation_release',
          referenceId: orderId,
          actor: 'system_timeout_releaser',
          note: `Released reservation of ${item.quantity} units due to order cancellation or timeout for ${orderId}`,
          timestamp: new Date().toISOString()
        });
      }
    }

    this.broadcast('inventory_update', {
      type: 'release',
      orderId,
      products: Array.from(this.products.values())
    });
  }

  // ==========================================================================
  // Category Management CRUD
  // ==========================================================================
  public getAllCategories(): Category[] {
    const list = Array.from(this.categories.values()).sort((a, b) => a.displayOrder - b.displayOrder);
    // Count products per category
    return list.map(cat => {
      const count = Array.from(this.products.values()).filter(p => p.category.toLowerCase() === cat.name.toLowerCase()).length;
      return { ...cat, productCount: count };
    });
  }

  public getCategoryById(id: string): Category | undefined {
    return this.categories.get(id);
  }

  public createCategory(data: Omit<Category, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>): Category {
    const id = `cat_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newCategory: Category = {
      ...data,
      id,
      slug: data.slug || data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      displayOrder: data.displayOrder || this.categories.size + 1,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.categories.set(id, newCategory);
    this.broadcast('category_update', { type: 'created', category: newCategory });
    return newCategory;
  }

  public updateCategory(id: string, updates: Partial<Category>): Category {
    const existing = this.categories.get(id);
    if (!existing) throw new Error(`Category ${id} not found`);

    const updated: Category = {
      ...existing,
      ...updates,
      id,
      updatedAt: new Date().toISOString()
    };

    this.categories.set(id, updated);
    this.broadcast('category_update', { type: 'updated', category: updated });
    return updated;
  }

  public deleteCategory(id: string): boolean {
    const existing = this.categories.get(id);
    if (!existing) return false;

    // Check if products exist in category
    const productsInCat = Array.from(this.products.values()).filter(
      p => p.category.toLowerCase() === existing.name.toLowerCase()
    );

    if (productsInCat.length > 0) {
      // Reassign to General / Electronics or update
      for (const prod of productsInCat) {
        prod.category = 'Electronics';
        prod.updatedAt = new Date().toISOString();
      }
    }

    const deleted = this.categories.delete(id);
    if (deleted) {
      this.broadcast('category_update', { type: 'deleted', categoryId: id });
    }
    return deleted;
  }

  // ==========================================================================
  // Tax Category Management CRUD (Dynamic, multi-jurisdiction scaling)
  // ==========================================================================
  public getAllTaxCategories(): TaxCategory[] {
    const list = Array.from(this.taxCategories.values());
    // Calculate products assigned to each tax category
    return list.map(tax => {
      const count = Array.from(this.products.values()).filter(p => p.taxCategoryId === tax.id).length;
      return { ...tax, productCount: count };
    });
  }

  public getTaxCategoryById(id: string): TaxCategory | undefined {
    return this.taxCategories.get(id);
  }

  public createTaxCategory(data: Omit<TaxCategory, 'id' | 'createdAt' | 'updatedAt' | 'productCount'>): TaxCategory {
    const id = `tax_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    
    // If set as default, unset others
    if (data.isDefault) {
      for (const tax of this.taxCategories.values()) {
        tax.isDefault = false;
      }
    }

    const newTax: TaxCategory = {
      ...data,
      id,
      code: (data.code || data.name).toUpperCase().replace(/[^A-Z0-9_]+/g, '_'),
      rate: Number(data.rate) || 0,
      isInclusive: data.isInclusive !== undefined ? data.isInclusive : true,
      isDefault: !!data.isDefault,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.taxCategories.set(id, newTax);
    this.broadcast('tax_update', { type: 'created', taxCategory: newTax });
    return newTax;
  }

  public updateTaxCategory(id: string, updates: Partial<TaxCategory>): TaxCategory {
    const existing = this.taxCategories.get(id);
    if (!existing) throw new Error(`Tax category ${id} not found`);

    if (updates.isDefault) {
      for (const tax of this.taxCategories.values()) {
        tax.isDefault = false;
      }
    }

    const updated: TaxCategory = {
      ...existing,
      ...updates,
      id,
      rate: updates.rate !== undefined ? Number(updates.rate) : existing.rate,
      updatedAt: new Date().toISOString()
    };

    this.taxCategories.set(id, updated);

    // Update any products using this tax category if tax rate changed
    if (updates.rate !== undefined || updates.name !== undefined) {
      for (const prod of this.products.values()) {
        if (prod.taxCategoryId === id) {
          if (updates.rate !== undefined) prod.taxRate = Number(updates.rate);
          if (updates.name !== undefined) prod.taxCategoryName = updates.name;
          prod.updatedAt = new Date().toISOString();
        }
      }
    }

    this.broadcast('tax_update', { type: 'updated', taxCategory: updated });
    return updated;
  }

  public deleteTaxCategory(id: string): boolean {
    const existing = this.taxCategories.get(id);
    if (!existing) return false;

    // Check if it's default
    if (existing.isDefault) {
      throw new Error('Cannot delete the default tax category. Set another category as default first.');
    }

    // Reassign products to standard default or remove taxCategoryId
    const defaultTax = Array.from(this.taxCategories.values()).find(t => t.isDefault && t.id !== id);
    for (const prod of this.products.values()) {
      if (prod.taxCategoryId === id) {
        if (defaultTax) {
          prod.taxCategoryId = defaultTax.id;
          prod.taxCategoryName = defaultTax.name;
          prod.taxRate = defaultTax.rate;
        } else {
          prod.taxCategoryId = undefined;
          prod.taxCategoryName = undefined;
          prod.taxRate = 0;
        }
        prod.updatedAt = new Date().toISOString();
      }
    }

    const deleted = this.taxCategories.delete(id);
    if (deleted) {
      this.broadcast('tax_update', { type: 'deleted', taxCategoryId: id });
    }
    return deleted;
  }

  public setDefaultTaxCategory(id: string): TaxCategory {
    const target = this.taxCategories.get(id);
    if (!target) throw new Error(`Tax category ${id} not found`);

    for (const tax of this.taxCategories.values()) {
      tax.isDefault = tax.id === id;
      tax.updatedAt = new Date().toISOString();
    }

    this.broadcast('tax_update', { type: 'default_changed', defaultId: id });
    return target;
  }

  // ==========================================================================
  // Currency Management CRUD (Multi-Market scaling)
  // ==========================================================================
  public getAllCurrencies(): CurrencyConfig[] {
    return Array.from(this.currencies.values()).sort((a, b) => {
      if (a.isBaseCurrency) return -1;
      if (b.isBaseCurrency) return 1;
      return a.code.localeCompare(b.code);
    });
  }

  public getCurrencyByCode(code: string): CurrencyConfig | undefined {
    return this.currencies.get(code.toUpperCase());
  }

  public createCurrency(data: CurrencyConfig): CurrencyConfig {
    const code = data.code.toUpperCase().trim();
    if (this.currencies.has(code)) {
      throw new Error(`Currency ${code} already exists.`);
    }

    if (data.isBaseCurrency) {
      for (const cur of this.currencies.values()) {
        cur.isBaseCurrency = false;
      }
    }

    const newCurrency: CurrencyConfig = {
      ...data,
      code,
      exchangeRate: Number(data.exchangeRate) || 1.0,
      decimalDigits: data.decimalDigits !== undefined ? Number(data.decimalDigits) : 2,
      symbolPosition: data.symbolPosition || 'prefix',
      isEnabled: data.isEnabled !== undefined ? data.isEnabled : true,
      updatedAt: new Date().toISOString()
    };

    this.currencies.set(code, newCurrency);
    this.broadcast('currency_update', { type: 'created', currency: newCurrency });
    return newCurrency;
  }

  public updateCurrency(code: string, updates: Partial<CurrencyConfig>): CurrencyConfig {
    const upperCode = code.toUpperCase().trim();
    const existing = this.currencies.get(upperCode);
    if (!existing) throw new Error(`Currency ${upperCode} not found`);

    if (updates.isBaseCurrency) {
      for (const cur of this.currencies.values()) {
        cur.isBaseCurrency = false;
      }
    }

    const updated: CurrencyConfig = {
      ...existing,
      ...updates,
      code: upperCode,
      exchangeRate: updates.exchangeRate !== undefined ? Number(updates.exchangeRate) : existing.exchangeRate,
      updatedAt: new Date().toISOString()
    };

    this.currencies.set(upperCode, updated);
    this.broadcast('currency_update', { type: 'updated', currency: updated });
    return updated;
  }

  public deleteCurrency(code: string): boolean {
    const upperCode = code.toUpperCase().trim();
    const existing = this.currencies.get(upperCode);
    if (!existing) return false;

    if (existing.isBaseCurrency) {
      throw new Error('Cannot delete the primary base currency. Designate another base currency first.');
    }

    const deleted = this.currencies.delete(upperCode);
    if (deleted) {
      this.broadcast('currency_update', { type: 'deleted', currencyCode: upperCode });
    }
    return deleted;
  }

  public setBaseCurrency(code: string): CurrencyConfig {
    const upperCode = code.toUpperCase().trim();
    const target = this.currencies.get(upperCode);
    if (!target) throw new Error(`Currency ${upperCode} not found`);

    for (const cur of this.currencies.values()) {
      cur.isBaseCurrency = cur.code === upperCode;
      cur.updatedAt = new Date().toISOString();
    }

    this.broadcast('currency_update', { type: 'base_changed', baseCurrency: upperCode });
    return target;
  }

  // ==========================================================================
  // Enterprise Inventory Operations (Receive, Write-off, Cycle Count Audit)
  // ==========================================================================
  
  // Stock In / PO Receiving
  public receiveStock(
    productId: string, 
    quantity: number, 
    supplier: string, 
    poNumber: string, 
    unitCost?: number, 
    notes?: string, 
    actor: string = 'admin'
  ): Product {
    const prod = this.products.get(productId);
    if (!prod) throw new Error(`Product ${productId} not found`);
    if (quantity <= 0) throw new Error('Received quantity must be greater than 0');

    const prevStock = prod.stockQuantity;
    prod.stockQuantity += quantity;
    if (unitCost !== undefined && unitCost > 0) {
      prod.costPrice = unitCost;
    }
    prod.updatedAt = new Date().toISOString();

    this.inventoryLedger.push({
      id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      productId: prod.id,
      productName: prod.name,
      changeAmount: quantity,
      previousStock: prevStock,
      newStock: prod.stockQuantity,
      changeType: 'purchase_order_receipt',
      referenceId: poNumber || `PO-${Date.now()}`,
      actor,
      note: `Received ${quantity} units from supplier "${supplier || 'Standard Supplier'}". ${notes || ''}`.trim(),
      timestamp: new Date().toISOString()
    });

    this.broadcast('inventory_update', {
      type: 'stock_received',
      productId: prod.id,
      products: Array.from(this.products.values())
    });

    return prod;
  }

  // Stock Out / Damage, Loss, Shrinkage Write-off
  public writeOffStock(
    productId: string, 
    quantity: number, 
    reasonCode: 'damage_transit' | 'defective_return' | 'warehouse_damage' | 'shrinkage_loss' | 'sample_marketing', 
    notes?: string, 
    actor: string = 'admin'
  ): Product {
    const prod = this.products.get(productId);
    if (!prod) throw new Error(`Product ${productId} not found`);
    if (quantity <= 0) throw new Error('Write-off quantity must be greater than 0');
    if (quantity > prod.stockQuantity) throw new Error(`Cannot write off ${quantity} units; only ${prod.stockQuantity} currently on hand.`);

    const prevStock = prod.stockQuantity;
    prod.stockQuantity -= quantity;
    prod.updatedAt = new Date().toISOString();

    const reasonLabelMap = {
      damage_transit: 'Damaged in Courier Transit',
      defective_return: 'Defective Customer Return',
      warehouse_damage: 'Damaged in Warehouse Storage',
      shrinkage_loss: 'Inventory Shrinkage / Missing Item',
      sample_marketing: 'Promotional / Demo Unit'
    };

    this.inventoryLedger.push({
      id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      productId: prod.id,
      productName: prod.name,
      changeAmount: -quantity,
      previousStock: prevStock,
      newStock: prod.stockQuantity,
      changeType: 'damage_writeoff',
      referenceId: `WRITEOFF-${Date.now()}`,
      actor,
      note: `Stock Write-off (${reasonLabelMap[reasonCode] || reasonCode}). ${notes || ''}`.trim(),
      timestamp: new Date().toISOString()
    });

    this.broadcast('inventory_update', {
      type: 'stock_writeoff',
      productId: prod.id,
      products: Array.from(this.products.values())
    });

    return prod;
  }

  // Physical Stock Count / Cycle Audit
  public physicalStockAudit(
    productId: string, 
    countedQuantity: number, 
    notes?: string, 
    actor: string = 'inventory_auditor'
  ): { product: Product; discrepancy: number } {
    const prod = this.products.get(productId);
    if (!prod) throw new Error(`Product ${productId} not found`);
    if (countedQuantity < 0) throw new Error('Physical count cannot be negative');

    const previousStock = prod.stockQuantity;
    const discrepancy = countedQuantity - previousStock;
    prod.stockQuantity = countedQuantity;
    prod.updatedAt = new Date().toISOString();

    this.inventoryLedger.push({
      id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      productId: prod.id,
      productName: prod.name,
      changeAmount: discrepancy,
      previousStock,
      newStock: countedQuantity,
      changeType: 'physical_audit',
      referenceId: `AUDIT-${Date.now()}`,
      actor,
      note: `Physical Shelf Count Audit: Counted ${countedQuantity} (Discrepancy: ${discrepancy >= 0 ? '+' : ''}${discrepancy}). ${notes || ''}`.trim(),
      timestamp: new Date().toISOString()
    });

    this.broadcast('inventory_update', {
      type: 'audit_completed',
      productId: prod.id,
      products: Array.from(this.products.values())
    });

    return { product: prod, discrepancy };
  }

  // Manual Stock Adjustment
  public manualAdjustStock(
    productId: string,
    newQuantity: number,
    reason: string = 'Manual Adjustment',
    actor: string = 'admin'
  ): Product {
    const prod = this.products.get(productId);
    if (!prod) throw new Error(`Product ${productId} not found`);
    if (newQuantity < 0) throw new Error('Stock quantity cannot be negative');

    const prevStock = prod.stockQuantity;
    const diff = newQuantity - prevStock;
    prod.stockQuantity = newQuantity;
    prod.updatedAt = new Date().toISOString();

    this.inventoryLedger.push({
      id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      productId: prod.id,
      productName: prod.name,
      changeAmount: diff,
      previousStock: prevStock,
      newStock: newQuantity,
      changeType: 'manual_adjustment',
      referenceId: `ADJ-${Date.now()}`,
      actor,
      note: reason,
      timestamp: new Date().toISOString()
    });

    this.broadcast('inventory_update', {
      type: 'stock_adjusted',
      productId: prod.id,
      products: Array.from(this.products.values())
    });

    return prod;
  }

  // Batch Stock Adjust
  public batchStockAdjust(
    adjustments: { productId: string; newQuantity: number; reason: string }[], 
    actor: string = 'admin'
  ): Product[] {
    const updated: Product[] = [];
    for (const adj of adjustments) {
      const prod = this.manualAdjustStock(adj.productId, adj.newQuantity, adj.reason, actor);
      if (prod) updated.push(prod);
    }
    return updated;
  }

  // ==========================================================================
  // Order Fulfillment & Lifecycle Operations
  // ==========================================================================
  public updateOrderStatus(
    orderId: string, 
    status: OrderStatus, 
    shippingCourier?: string, 
    trackingNumber?: string, 
    internalNotes?: string
  ): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    order.status = status;
    if (shippingCourier) order.shippingCourier = shippingCourier;
    if (trackingNumber) order.trackingNumber = trackingNumber;
    if (internalNotes !== undefined) order.internalNotes = internalNotes;

    if (status === 'shipped' && !order.shippedAt) {
      order.shippedAt = new Date().toISOString();
    }
    if (status === 'delivered' && !order.deliveredAt) {
      order.deliveredAt = new Date().toISOString();
    }
    if (status === 'completed' && !order.deliveredAt) {
      order.deliveredAt = new Date().toISOString();
    }

    order.updatedAt = new Date().toISOString();
    this.broadcast('order_updated', order);
    return order;
  }

  public cancelOrderAndRestock(orderId: string, reason: string, actor: string = 'admin'): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    if (order.status === 'cancelled') {
      throw new Error('Order is already cancelled');
    }

    // Restock items
    for (const item of order.items) {
      const prod = this.products.get(item.productId);
      if (prod) {
        const prevStock = prod.stockQuantity;
        prod.stockQuantity += item.quantity;
        prod.updatedAt = new Date().toISOString();

        this.inventoryLedger.push({
          id: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          productId: prod.id,
          productName: prod.name,
          changeAmount: item.quantity,
          previousStock: prevStock,
          newStock: prod.stockQuantity,
          changeType: 'order_cancellation_release',
          referenceId: order.orderNumber,
          actor,
          note: `Restocked ${item.quantity} units due to cancellation of order ${order.orderNumber}. Reason: ${reason || 'Admin Cancelled'}`,
          timestamp: new Date().toISOString()
        });
      }
    }

    order.status = 'cancelled';
    order.internalNotes = `${order.internalNotes ? order.internalNotes + '\n' : ''}[Cancelled by ${actor}: ${reason}]`;
    order.updatedAt = new Date().toISOString();

    this.broadcast('order_updated', order);
    this.broadcast('inventory_update', {
      type: 'order_cancelled_restock',
      orderId,
      products: Array.from(this.products.values())
    });

    return order;
  }
}

const globalForDb = globalThis as unknown as { omniDb?: PostgresStore };

export const db = globalForDb.omniDb ?? new PostgresStore();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.omniDb = db;
}
