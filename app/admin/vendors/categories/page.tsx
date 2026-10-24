import { Suspense } from 'react';
import { categoriesAction } from '@/server/domains/vendors/prequal-actions';
import { CategoriesClient } from '@/components/admin/vendors/CategoriesClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = categoriesAction();
  return (
    <Suspense fallback={<PageSkeleton label="categories" />}>
      <CategoriesClient initialPromise={initial} />
    </Suspense>
  );
}
