import { describe, expect, it } from 'vitest';
import { savedWords, submitWords } from './form-words';

describe('form words', () => {
  it('says created or saved', () => {
    expect(savedWords(null, 'Value')).toBe('Value created.');
    expect(savedWords('x', 'Value')).toBe('Value saved.');
  });
  it('words the submit button', () => {
    expect(submitWords(true, null, 'Create')).toBe('Saving…');
    expect(submitWords(false, null, 'Create')).toBe('Create');
    expect(submitWords(false, 'x', 'Create')).toBe('Save changes');
  });
});
