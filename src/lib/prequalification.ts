/** Rules for categories, questionnaires and scoring (design doc §7). Pure: shared by the forms and the server. */

export type QuestionKind = 'yes_no' | 'number' | 'text' | 'choice';

export const QUESTION_KINDS: readonly { id: QuestionKind; label: string }[] = [
  { id: 'yes_no', label: 'Yes or no' },
  { id: 'number', label: 'A number' },
  { id: 'text', label: 'A written answer' },
  { id: 'choice', label: 'One of several choices' },
];

export const STATUS_WORDS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  submitted: { label: 'Sent, waiting for an evaluator', tone: 'amber' },
  in_review: { label: 'Being evaluated', tone: 'sky' },
  revision_requested: { label: 'Changes asked for', tone: 'amber' },
  approved: { label: 'Qualified', tone: 'green' },
  rejected: { label: 'Not accepted', tone: 'red' },
  withdrawn: { label: 'Withdrawn', tone: 'gray' },
  expired: { label: 'Expired', tone: 'gray' },
  suspended: { label: 'Suspended', tone: 'red' },
  revoked: { label: 'Revoked', tone: 'red' },
};

/** The statuses in which a vendor holds a place in the category (one at a time). */
export const LIVE_STATUSES = ['draft', 'submitted', 'in_review', 'revision_requested', 'approved', 'suspended'] as const;

export interface CategoryForm {
  code: string;
  name: string;
  description: string;
  parentId: string;
  validityMonths: string;
  windowFrom: string;
  windowTo: string;
  passMarkPercent: string;
  fourEyes: boolean;
  showTotalScore: boolean;
  showPassMark: boolean;
  showQuestionScores: boolean;
  showEvaluatorComments: boolean;
}

export const emptyCategory = (): CategoryForm => ({ code: '', name: '', description: '', parentId: '', validityMonths: '24', windowFrom: '', windowTo: '', passMarkPercent: '', fourEyes: true, showTotalScore: false, showPassMark: false, showQuestionScores: false, showEvaluatorComments: false });

const CODE = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function checkCategory(f: CategoryForm, creating: boolean): Record<string, string> {
  const p: Record<string, string> = {};
  if (creating && !CODE.test(f.code.trim().toUpperCase())) p.code = 'Use capital letters, digits, dots, dashes or underscores, up to 30 characters (for example SOLAR).';
  if (f.name.trim().length < 2 || f.name.trim().length > 120) p.name = 'Give the category a name of 2 to 120 characters.';
  const months = Number(f.validityMonths);
  if (!/^\d{1,3}$/.test(f.validityMonths.trim()) || months < 1 || months > 120) p.validityMonths = 'Say how many months a qualification lasts, from 1 to 120.';
  if (f.passMarkPercent.trim() !== '') {
    const mark = Number(f.passMarkPercent);
    if (!Number.isFinite(mark) || mark < 0 || mark > 100) p.passMarkPercent = 'The pass mark is a percentage from 0 to 100, or leave it empty to decide without a score.';
  }
  for (const key of ['windowFrom', 'windowTo'] as const) {
    if (f[key].trim() !== '' && !DATE.test(f[key].trim())) p[key] = 'Use a date like 2026-12-31.';
  }
  if (p.windowFrom === undefined && p.windowTo === undefined && f.windowFrom !== '' && f.windowTo !== '' && f.windowTo < f.windowFrom) p.windowTo = 'The window cannot end before it starts.';
  return p;
}

export interface QuestionForm {
  prompt: string;
  kind: QuestionKind;
  /** One choice per line. */
  choices: string;
  weight: string;
  required: boolean;
}

export const emptyQuestion = (): QuestionForm => ({ prompt: '', kind: 'yes_no', choices: '', weight: '0', required: true });

export const choiceList = (text: string): string[] => [...new Set(text.split('\n').map((c) => c.trim()).filter((c) => c !== ''))];

export function checkQuestion(q: QuestionForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (q.prompt.trim().length < 3 || q.prompt.trim().length > 300) p.prompt = 'Write the question in 3 to 300 characters.';
  if (!QUESTION_KINDS.some((k) => k.id === q.kind)) p.kind = 'Choose the kind of answer.';
  if (q.kind === 'choice') {
    const n = choiceList(q.choices).length;
    if (n < 2 || n > 12) p.choices = 'Give 2 to 12 different choices, one on each line.';
  }
  const w = Number(q.weight);
  if (!/^\d{1,3}$/.test(q.weight.trim()) || w > 100) p.weight = 'The most points a question can earn is a whole number from 0 to 100 (0 = not scored).';
  return p;
}

interface Asked {
  id: string;
  prompt: string;
  kind: QuestionKind;
  choices: readonly string[];
  required: boolean;
}

/** What is wrong with one answer, or null. */
export function checkAnswer(q: Pick<Asked, 'kind' | 'choices'>, value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  if (q.kind === 'yes_no') return v === 'yes' || v === 'no' ? null : 'Answer yes or no.';
  if (q.kind === 'number') return Number.isFinite(Number(v)) && v.length <= 20 ? null : 'Enter a number.';
  if (q.kind === 'choice') return q.choices.includes(v) ? null : 'Choose one of the listed answers.';
  return v.length <= 2000 ? null : 'Keep the answer under 2000 characters.';
}

/** Problems with the answers given, keyed by question id: a wrong kind of answer, or a required question left empty. */
export function answerProblems(questions: readonly Asked[], answers: Readonly<Record<string, string>>, forSubmit: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const v = (answers[q.id] ?? '').trim();
    const wrong = checkAnswer(q, v);
    if (wrong !== null) out[q.id] = wrong;
    else if (forSubmit && q.required && v === '') out[q.id] = 'This question needs an answer.';
  }
  return out;
}

export interface ScoreInput {
  questionId: string;
  evaluatorId: string;
  score: number;
}

/** The evaluators' scores averaged per question and added up, against the most the questions could earn. */
export function scoreTotals(weights: Readonly<Record<string, number>>, scores: readonly ScoreInput[]): { total: number; max: number } {
  let total = 0;
  let max = 0;
  for (const [questionId, weight] of Object.entries(weights)) {
    max += weight;
    const given = scores.filter((s) => s.questionId === questionId);
    if (given.length > 0) total += given.reduce((a, s) => a + s.score, 0) / given.length;
  }
  return { total: Math.round(total * 100) / 100, max };
}

/** Whether the score passes: null when there is no pass mark or nothing to score. */
export function passes(total: number, max: number, passMarkPercent: number | null): boolean | null {
  if (passMarkPercent === null || max === 0) return null;
  return (total / max) * 100 >= passMarkPercent;
}

/** The last day of a qualification that starts on `from` (YYYY-MM-DD) and lasts `months`. */
export function validUntil(from: string, months: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastOfMonth));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Vendors may apply while the category is open and today is inside its window (either end may be empty). */
export function acceptingApplications(status: string, windowFrom: string | null, windowTo: string | null, today: string): boolean {
  if (status !== 'open') return false;
  if (windowFrom !== null && today < windowFrom) return false;
  return windowTo === null || today <= windowTo;
}
