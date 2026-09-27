'use client';

import { useEffect, useState, useRef } from 'react';

export interface RealtimeEventPayload {
  type: string;
  [key: string]: any;
}

export function useRealtimeSync(onEvent?: (event: string, data: any) => void) {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [lastEvent, setLastEvent] = useState<{ event: string; data: any; time: number } | null>(
    null,
  );
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: any = null;

    function connect() {
      try {
        eventSource = new EventSource('/api/events');

        eventSource.onopen = () => {
          setIsConnected(true);
        };

        const handleAnyMessage = (e: MessageEvent, eventName: string) => {
          try {
            const parsed = JSON.parse(e.data);
            setLastEvent({ event: eventName, data: parsed, time: Date.now() });
            if (onEventRef.current) {
              onEventRef.current(eventName, parsed);
            }
          } catch (err) {
            console.error('Failed to parse SSE payload:', err);
          }
        };

        eventSource.onmessage = (e) => handleAnyMessage(e, 'message');
        eventSource.addEventListener('inventory_update', (e) =>
          handleAnyMessage(e, 'inventory_update'),
        );
        eventSource.addEventListener('transaction_event', (e) =>
          handleAnyMessage(e, 'transaction_event'),
        );
        eventSource.addEventListener('order_event', (e) => handleAnyMessage(e, 'order_event'));
        eventSource.addEventListener('reconciliation_event', (e) =>
          handleAnyMessage(e, 'reconciliation_event'),
        );
        eventSource.addEventListener('payment_gateway_updated', (e) =>
          handleAnyMessage(e, 'payment_gateway_updated'),
        );
        eventSource.addEventListener('payment_callback_processed', (e) =>
          handleAnyMessage(e, 'payment_callback_processed'),
        );

        eventSource.onerror = () => {
          setIsConnected(false);
          eventSource?.close();
          reconnectTimeout = setTimeout(connect, 3000);
        };
      } catch (err) {
        setIsConnected(false);
        reconnectTimeout = setTimeout(connect, 3000);
      }
    }

    connect();

    return () => {
      if (eventSource) eventSource.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, []);

  return { isConnected, lastEvent };
}

export function useRealtimeEvents(onEvent?: (event: { type: string; data: any }) => void) {
  return useRealtimeSync((eventName, data) => {
    if (onEvent) {
      onEvent({ type: eventName, data });
    }
  });
}
