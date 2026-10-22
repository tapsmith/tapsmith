import { describe, it, expect } from 'vitest';
import { formatBounds } from '../mcp/locator-helper.js';

describe('formatBounds', () => {
  it('renders hierarchy-XML style bounds', () => {
    expect(formatBounds({ left: 1, top: 2, right: 3, bottom: 4 })).toBe('[1,2][3,4]');
    expect(formatBounds(undefined)).toBe('');
  });
});
