/** "Value created." or "Value saved.", by whether the form was making a new one or changing one. */
export const savedWords = (editingId: string | null, noun: string): string => (editingId === null ? `${noun} created.` : `${noun} saved.`);

/** The words on a form's submit button: busy, making a new one, or changing one. */
export function submitWords(busy: boolean, editingId: string | null, createLabel: string): string {
  if (busy) return 'Saving…';
  return editingId === null ? createLabel : 'Save changes';
}
