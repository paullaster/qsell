// The pure checks the screens run as you type, kept apart from the server actions file (which may
// export only async functions).
export { checkRebateProgram } from './domain/rebate';
import { checkLoyalty, type LoyaltyConfig } from './domain/loyalty';

export const checkLoyaltyFor = (c: LoyaltyConfig) => checkLoyalty(c);
