/**
 * S-expression tokenizer for `.cicada_sch` files.
 *
 * Produces a flat token stream consumed by the parser in `read.ts`.
 * Quoted strings support backslash escapes (`\"`, `\\`); bare atoms run until
 * whitespace or a paren/quote delimiter.
 */

export type Token =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'str'; value: string }
  | { type: 'atom'; value: string }

/** Thrown when the text is not tokenizable (unterminated string). */
export class TokenizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenizeError'
  }
}

/** Tokenize schematic text into an S-expression token stream. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === undefined) break
    if (c === '(') {
      tokens.push({ type: 'open' })
      i++
    } else if (c === ')') {
      tokens.push({ type: 'close' })
      i++
    } else if (c === '"') {
      const { value, next } = readString(text, i)
      tokens.push({ type: 'str', value })
      i = next
    } else if (isWhitespace(c)) {
      i++
    } else {
      let j = i
      while (j < n) {
        const ch = text[j]
        if (ch === undefined || isWhitespace(ch) || ch === '(' || ch === ')' || ch === '"') break
        j++
      }
      tokens.push({ type: 'atom', value: text.slice(i, j) })
      i = j
    }
  }
  return tokens
}

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}

/** Read one quoted string starting at the opening quote; returns value and index after the closing quote. */
function readString(text: string, start: number): { value: string; next: number } {
  const n = text.length
  let value = ''
  let i = start + 1
  while (i < n) {
    const c = text[i]
    if (c === '\\') {
      const esc = text[i + 1]
      if (esc === undefined) throw new TokenizeError('unterminated escape at end of input')
      value += esc
      i += 2
    } else if (c === '"') {
      return { value, next: i + 1 }
    } else {
      value += c
      i++
    }
  }
  throw new TokenizeError('unterminated string')
}
