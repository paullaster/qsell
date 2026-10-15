'use client';

import { useEffect, useState } from 'react';

/** A value that follows `value` only after it has stayed the same for `delayMs`: typing is not a request per key. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
