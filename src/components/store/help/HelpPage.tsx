import type { HelpView } from '@/lib/seo/help';

/** The company's contacts, guarantees and questions as plain, readable text that search engines can read. */
export function HelpPage({ view }: { view: HelpView }) {
  return (
    <article className="mx-auto max-w-3xl space-y-10 pb-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold text-fg-strong">{view.title}</h1>
        <p className="text-fg-muted">{view.intro}</p>
      </header>

      <section aria-labelledby="contact-heading" className="space-y-3">
        <h2 id="contact-heading" className="text-xl font-bold text-fg-strong">Contact us</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {view.contacts.map((contact) => (
            <li key={contact.key} className="rounded-xl border border-line bg-surface p-4">
              <p className="text-xs font-bold tracking-wide text-fg-muted uppercase">{contact.label}</p>
              {contact.href === null ? (
                <p className="mt-1 break-words text-fg">{contact.value}</p>
              ) : (
                <a href={contact.href} {...(contact.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})} className="mt-1 inline-flex min-h-10 items-center break-words text-fg underline-offset-2 hover:underline">{contact.value}</a>
              )}
              {contact.detail === '' ? null : <p className="text-sm text-fg-muted">{contact.detail}</p>}
            </li>
          ))}
        </ul>
      </section>

      {view.guarantees.length > 0 ? (
        <section aria-labelledby="guarantees-heading" className="space-y-3">
          <h2 id="guarantees-heading" className="text-xl font-bold text-fg-strong">{view.guaranteesTitle}</h2>
          <ul className="list-disc space-y-2 pl-6 text-fg">
            {view.guarantees.map((text) => <li key={text}>{text}</li>)}
          </ul>
        </section>
      ) : null}

      {view.faqs.length > 0 ? (
        <section aria-labelledby="faq-heading" className="space-y-4">
          <h2 id="faq-heading" className="text-xl font-bold text-fg-strong">{view.faqsTitle}</h2>
          <dl className="space-y-5">
            {view.faqs.map((faq) => (
              <div key={faq.id}>
                <dt className="font-semibold text-fg-strong">{faq.question}</dt>
                <dd className="mt-1 whitespace-pre-line text-fg-muted">{faq.answer}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </article>
  );
}
