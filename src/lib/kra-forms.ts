import type { SigningModule } from '@/server/domains/kra/signing/types';

export type KraEnvironmentId = 'sandbox' | 'production';
export type ConnectionId = 'tcp' | 'com';
/** A branch's choice for one module: follow the company, or an explicit on or off. */
export type ModuleChoice = '' | 'on' | 'off';

export const ENVIRONMENTS: readonly { id: KraEnvironmentId; label: string }[] = [
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'production', label: 'Production' },
];

export const CONNECTIONS: readonly { id: ConnectionId; label: string }[] = [
  { id: 'tcp', label: 'TCP / IP' },
  { id: 'com', label: 'Serial (COM)' },
];

export const MODES = [
  { value: 'etims' as const, title: 'eTIMS', blurb: 'Invoices are sent to KRA online through the eTIMS gateway.' },
  { value: 'tims' as const, title: 'TIMS', blurb: 'Invoices are signed by a Tremol control unit through ZFPLabServer.' },
];

export const labelOfEnvironment = (id: string): string => ENVIRONMENTS.find((e) => e.id === id)?.label ?? id;
export const labelOfConnection = (id: string): string => CONNECTIONS.find((c) => c.id === id)?.label ?? id;

/** The words for a branch's choice about one module; "inherited" is what the company has set. */
export function moduleChoices(inherited: 'on' | 'off'): readonly { id: ModuleChoice; label: string }[] {
  return [
    { id: '', label: `Use company setting (${inherited})` },
    { id: 'on', label: 'On for this branch' },
    { id: 'off', label: 'Off for this branch' },
  ];
}

export function moduleChoiceOf(value: boolean | undefined): ModuleChoice {
  if (value === undefined) return '';
  return value ? 'on' : 'off';
}

/** What the company has set for a module, as the branch screen shows it. */
export const inheritedWords = (value: boolean | undefined): 'on' | 'off' => (value === true ? 'on' : 'off');

/** The module switches after one is changed; '' removes the branch's own choice so it follows the company. */
export function withModuleSigning(current: Partial<Record<SigningModule, boolean>>, module: SigningModule, choice: ModuleChoice): Partial<Record<SigningModule, boolean>> {
  const { [module]: _gone, ...rest } = current;
  return choice === '' ? rest : { ...rest, [module]: choice === 'on' };
}

export interface KraFormLike {
  mode: 'tims' | 'etims';
  isEnabled: boolean;
  environment: KraEnvironmentId;
  apiBaseUrl: string;
  username: string;
  password: string;
  zfpLabServerUrl: string;
  connection: ConnectionId;
  cuSerial: string;
  allowEtimsSigning: boolean;
  allowTimsSigning: boolean;
  moduleSigning: Partial<Record<SigningModule, boolean>>;
}

export interface KraViewLike extends Omit<KraFormLike, 'password'> {
  hasPassword: boolean;
}

/** The form's starting values from what is saved (never the password) or, with nothing saved, safe defaults. */
export function kraFormFrom(view: KraViewLike | null): KraFormLike {
  return {
    mode: view?.mode ?? 'etims',
    isEnabled: view?.isEnabled ?? false,
    environment: view?.environment ?? 'sandbox',
    apiBaseUrl: view?.apiBaseUrl ?? '',
    username: view?.username ?? '',
    password: '',
    zfpLabServerUrl: view?.zfpLabServerUrl ?? '',
    connection: view?.connection ?? 'tcp',
    cuSerial: view?.cuSerial ?? '',
    allowEtimsSigning: view?.allowEtimsSigning ?? false,
    allowTimsSigning: view?.allowTimsSigning ?? false,
    moduleSigning: view?.moduleSigning ?? {},
  };
}
