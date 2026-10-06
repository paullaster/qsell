export type KraMode = 'tims' | 'etims';
export type KraEnvironment = 'sandbox' | 'production';
export type KraConfigSource = 'company' | 'branch';
export type KraTransmissionStatus = 'pending' | 'succeeded' | 'failed';

export const KRA_MODES: readonly KraMode[] = ['tims', 'etims'];

/** Stable machine-readable reasons the KRA configuration could not be used. */
export type KraConfigErrorCode =
  | 'BRANCH_NOT_FOUND'
  | 'BRANCH_INACTIVE'
  | 'BRANCH_CONFIG_MISSING'
  | 'COMPANY_CONFIG_MISSING'
  | 'CONFIG_DISABLED'
  | 'CONFIG_INCOMPLETE'
  | 'MODE_MISMATCH';

/** Thrown whenever the required KRA configuration is unavailable. Callers must not proceed. */
export class KraConfigError extends Error {
  constructor(
    readonly code: KraConfigErrorCode,
    message: string,
    readonly source?: KraConfigSource,
  ) {
    super(message);
    this.name = 'KraConfigError';
  }
}

export interface EtimsCredentials {
  username: string;
  password: string;
}

export interface TimsSettings {
  zfpLabServerUrl: string;
  connection: 'tcp' | 'com';
  cuSerial: string;
}

interface ResolvedBase {
  /** Which table the config was read from. */
  source: KraConfigSource;
  /** Set when source is 'branch'. */
  branchId: string | null;
  environment: KraEnvironment;
}

export interface ResolvedEtimsConfig extends ResolvedBase {
  mode: 'etims';
  apiBaseUrl: string;
  credentials: EtimsCredentials;
}

export interface ResolvedTimsConfig extends ResolvedBase {
  mode: 'tims';
  settings: TimsSettings;
}

export type ResolvedKraConfig = ResolvedEtimsConfig | ResolvedTimsConfig;
