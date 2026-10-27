import type { PlatformView } from '@/lib/seo/platform';

/** What the software can do, module by module, in everyday words. */
export function PlatformPage({ view }: { view: PlatformView }) {
  return (
    <article className="mx-auto max-w-4xl space-y-10 pb-16">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold text-fg-strong">{view.heading}</h1>
        <p className="text-lg leading-relaxed text-fg-muted">{view.intro}</p>
      </header>
      {view.modules.map((module) => (
        <section key={module.navId} aria-labelledby={`module-${module.navId}`} className="space-y-3">
          <h2 id={`module-${module.navId}`} className="text-xl font-bold text-fg-strong">{module.name}</h2>
          <p className="text-fg-muted">{module.summary}</p>
          <ul className="list-disc space-y-1 pl-6 text-fg">
            {module.features.map((feature) => <li key={feature}>{feature}</li>)}
          </ul>
          {module.subModules.length > 0 ? (
            <p className="text-sm text-fg-muted">Includes: {module.subModules.join(', ')}.</p>
          ) : null}
        </section>
      ))}
    </article>
  );
}
