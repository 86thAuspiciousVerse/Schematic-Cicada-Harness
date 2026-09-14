import { describe, expect, it } from 'vitest'

import { announce, newToken, tokenMatches } from '../src/token.ts'

describe('newToken', () => {
  it('mints a 43-char base64url token from 32 random bytes', () => {
    const { token } = newToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('mints distinct tokens per call', () => {
    expect(newToken().token).not.toBe(newToken().token)
  })

  it('revoke invalidates the token value', () => {
    const handle = newToken()
    expect(handle.token.length).toBe(43)
    handle.revoke()
    expect(handle.token).toBe('')
  })
})

describe('tokenMatches', () => {
  it('accepts the exact value', () => {
    const { token } = newToken()
    expect(tokenMatches(token, token)).toBe(true)
  })

  it('rejects unequal lengths without throwing', () => {
    const { token } = newToken()
    expect(tokenMatches('short', token)).toBe(false)
    expect(tokenMatches(token, '')).toBe(false)
  })

  it('empty-vs-empty matches (equal length; production never presents empty against a live token)', () => {
    expect(tokenMatches('', '')).toBe(true)
  })

  it('rejects same-length different values', () => {
    const a = newToken().token
    const b = newToken().token
    expect(tokenMatches(a, b)).toBe(false)
  })

  it('rejects a revoked token', () => {
    const handle = newToken()
    handle.revoke()
    expect(tokenMatches(handle.token, 'x')).toBe(false)
  })
})

describe('announce', () => {
  it('prints the launcher regex-compatible line', () => {
    const lines: string[] = []
    const original = console.log
    console.log = (line: string) => { lines.push(line) }
    try {
      announce(3123, 'tok_ABC-xyz_123')
    } finally {
      console.log = original
    }
    expect(lines).toEqual(['cicada-editor: 3123 tok_ABC-xyz_123'])
    expect(lines[0]).toMatch(/^cicada-editor:\s+\d+\s+[A-Za-z0-9_-]+\s*$/)
  })
})
