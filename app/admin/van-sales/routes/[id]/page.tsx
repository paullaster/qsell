import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { RouteDetailClient } from '@/components/admin/van-sales/RouteDetailClient';
import { MissingAs404 } from '@/components/ui/missing-record';
import { routeScreenAction } from '@/server/domains/van-sales/actions';

export const metadata: Metadata = { title: 'Route' };

export default function RoutePage({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => routeScreenAction(id));
  return (
    <SettingsFrame label="the route">
      <MissingAs404 result={view}>
        <RouteDetailClient viewPromise={view} />
      </MissingAs404>
    </SettingsFrame>
  );
}
