import { describe, expect, it } from 'vitest'

import { TokenizeError, tokenize } from '../src/tokenizer.ts'

describe('tokenize', () => {
  it('tokenizes simple lists', () => {
    expect(tokenize('(a b (c 1))')).toEqual([
      { type: 'open' },
      { type: 'atom', value: 'a' },
      { type: 'atom', value: 'b' },
      { type: 'open' },
      { type: 'atom', value: 'c' },
      { type: 'atom', value: '1' },
      { type: 'close' },
      { type: 'close' },
    ])
  })

  it('keeps quoted strings with spaces as one token', () => {
    expect(tokenize('(label "NET 1")')).toEqual([
      { type: 'open' },
      { type: 'atom', value: 'label' },
      { type: 'str', value: 'NET 1' },
      { type: 'close' },
    ])
  })

  it('handles escaped quotes and backslashes', () => {
    expect(tokenize('"a \\" b \\\\ c"')).toEqual([{ type: 'str', value: 'a " b \\ c' }])
  })

  it('treats CRLF as whitespace', () => {
    expect(tokenize('(a\r\nb)')).toHaveLength(4)
  })

  it('throws on unterminated string', () => {
    expect(() => tokenize('(label "x)')).toThrow(TokenizeError)
  })
})
