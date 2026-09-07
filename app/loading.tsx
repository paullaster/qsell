import { SkeletonGrid } from '@/components/ui/Skeletons';

export default function Loading() {
  return (
    <div className="min-h-screen bg-black text-zinc-300">
      <div className="h-16 border-b border-zinc-800 bg-zinc-950" />
      <div className="storefront-shell pt-8">
        <SkeletonGrid count={8} />
      </div>
    </div>
  );
}
