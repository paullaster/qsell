/**
 * pending      row created, gateway call in flight (or interrupted)
 * registered   KRA confirmed and we hold the item code
 * unconfirmed  gateway accepted the item but we could not learn its code
 * failed       gateway rejected it or was unreachable
 * deleted      removed at KRA
 */
export type EtimsItemStatus = 'pending' | 'registered' | 'unconfirmed' | 'failed' | 'deleted';
