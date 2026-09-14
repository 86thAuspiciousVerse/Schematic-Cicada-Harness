/**
 * MinerU token resolution (docs/05 §8): the settings document is the product
 * channel, and it only works because the plugin REGISTERS the `mineru`
 * namespace — `Settings.get(ns)` answers `undefined` for unregistered
 * namespaces, which silently disabled the tool in the product (probes worked
 * only because their launcher exported MINERU_TOKEN).
 */
import { describe, expect, it, vi } from 'vitest'
import { MINERU_SETTINGS_NAMESPACE, MineruSettingsSchema, resolveMineruToken } from '../src/index.ts'

describe('resolveMineruToken', () => {
  it('prefers the settings document over config and the environment', () => {
    expect(resolveMineruToken({ token: 'from-config' }, { get: () => ({ token: 'from-settings' }) }, { MINERU_TOKEN: 'from-env' }))
      .toBe('from-settings')
  })

  it('falls back to config, then the environment', () => {
    expect(resolveMineruToken({ token: 'from-config' }, { get: () => ({ token: '' }) }, { MINERU_TOKEN: 'from-env' }))
      .toBe('from-config')
    expect(resolveMineruToken({}, { get: () => ({}) }, { MINERU_TOKEN: 'from-env' })).toBe('from-env')
  })

  it('reports "no token" only when every source is empty', () => {
    expect(resolveMineruToken({}, undefined, undefined)).toBeUndefined()
    expect(resolveMineruToken({ token: '' }, { get: () => ({ token: '' }) }, {})).toBeUndefined()
  })

  it('ignores non-string values instead of passing them to the client', () => {
    expect(resolveMineruToken({}, { get: () => ({ token: 42 }) }, { MINERU_TOKEN: 'from-env' })).toBe('from-env')
  })
})

describe('settings schema', () => {
  it('defaults to an empty section so an absent document entry resolves', () => {
    const resolved = MineruSettingsSchema({}) as { token: string; baseUrl: string }
    expect(resolved.token).toBe('')
    expect(resolved.baseUrl).toBe('')
  })

  it('is registered under the namespace the document uses', () => {
    expect(MINERU_SETTINGS_NAMESPACE).toBe('mineru')
  })
})
