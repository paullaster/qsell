/** True for a text that has something in it. It also tells the compiler the value is a string from then on. */
export const has = (value: string | null | undefined): value is string => value !== null && value !== undefined && value !== '';
