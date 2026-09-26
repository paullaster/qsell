import { SkeletonGrid } from '@/components/ui/Skeletons';

export default function Loading() {
  return (
    <div className="min-h-screen bg-canvas text-fg">
      <div className="h-16 border-b border-line bg-surface" />
      <div className="storefront-shell pt-8">
        <SkeletonGrid count={8} />
      </div>
    </div>
  );
}
