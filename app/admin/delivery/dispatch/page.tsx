import type { Metadata } from 'next';
import { DispatchBoardClient } from '@/components/admin/delivery/DispatchBoardClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { dispatchBoardAction } from '@/server/domains/delivery/run-actions';

export const metadata: Metadata = { title: 'Dispatch board' };

export default function DispatchBoardPage() {
  const board = dispatchBoardAction({});
  return (
    <SettingsFrame label="the dispatch board">
      <DispatchBoardClient firstLoad={board} />
    </SettingsFrame>
  );
}
