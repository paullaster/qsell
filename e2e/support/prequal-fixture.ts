/**
 * Makes an open category for one test, and optionally an application by an existing approved vendor. Run with the e2e environment:
 *   tsx e2e/support/prequal-fixture.ts <tag> <vendorId|-> category|submitted|evaluated
 * `category` is an open category with two scored questions (10 and 20 points) and one that is not scored; `submitted` adds a
 * sent application by the vendor; `evaluated` adds an evaluator (someone else) who has given full marks. Prints one JSON line.
 */
const MODES = ['category', 'submitted', 'evaluated'];

async function main(): Promise<void> {
  const [tag, vendorId, mode] = process.argv.slice(2);
  if (tag === undefined || vendorId === undefined || mode === undefined || !MODES.includes(mode)) throw new Error(`usage: prequal-fixture <tag> <vendorId|-> ${MODES.join('|')}`);
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const staff = (id: string) => ({ companyId: company.id, actor: { type: 'user' as const, id }, origin: { surface: 'e2e', action: 'fixture' } });
  const name = `Fixture Category ${tag}`;
  const made = await container.categories.save(company.id, null, { code: `FX_${tag}`.toUpperCase().slice(0, 30), name, description: 'Supply and install solar systems', parentId: '', validityMonths: '24', windowFrom: '', windowTo: '', passMarkPercent: '60', fourEyes: true, showTotalScore: false, showPassMark: false, showQuestionScores: false, showEvaluatorComments: false });
  await container.categories.addQuestion(company.id, made.id, { prompt: 'Do you hold ISO 9001 certification?', kind: 'yes_no', choices: '', weight: '10', required: true });
  await container.categories.addQuestion(company.id, made.id, { prompt: 'How many projects did you finish last year?', kind: 'number', choices: '', weight: '20', required: true });
  await container.categories.addQuestion(company.id, made.id, { prompt: 'Anything else we should know?', kind: 'text', choices: '', weight: '0', required: false });
  await container.categories.setStatus(company.id, made.id, 'open');
  const out: Record<string, unknown> = { categoryId: made.id, categoryName: name };
  if (mode !== 'category') {
    const [link] = await db.select().from(schema.vendorUsers).where(eq(schema.vendorUsers.vendorId, vendorId));
    if (link === undefined) throw new Error('that vendor has no owner');
    const actor = { vendorId, userId: link.userId, portalRole: 'owner' as const };
    const today = new Date().toISOString().slice(0, 10);
    const { ids } = await container.prequal.apply(actor, company.id, [made.id], today);
    const entryId = ids[0] ?? '';
    const got = await container.categories.get(company.id, made.id);
    const questions = got?.questions ?? [];
    await container.prequal.saveAnswers(actor, entryId, Object.fromEntries(questions.filter((q) => q.kind !== 'text').map((q) => [q.id, q.kind === 'yes_no' ? 'yes' : '14'])));
    await container.prequal.submit(actor, entryId);
    out.entryId = entryId;
    if (mode === 'evaluated') {
      await container.prequalReview.take(staff('e2e-evaluator'), entryId);
      await container.prequalReview.saveScores(staff('e2e-evaluator'), entryId, questions.filter((q) => q.weight > 0).map((q) => ({ questionId: q.id, score: q.weight, comment: 'Evidence seen' })));
    }
  }
  process.stdout.write(`FIXTURE ${JSON.stringify(out)}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
