import type { SocialTag } from '@/lib/seo/social';

/** React places these in the page head. They are the product tags the metadata API has no field for. */
export function ProductSocialMeta({ tags }: { tags: SocialTag[] }) {
  return (
    <>
      {tags.map((tag) => (
        <meta key={tag.property} property={tag.property} content={tag.content} />
      ))}
    </>
  );
}
