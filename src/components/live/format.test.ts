import { describe, expect, it } from 'vitest'
import { formatCode, formatCountdown, isLoopbackHost, svgDataUri, unreachableHint } from './format'

describe('formatCountdown', () => {
  it('shows minutes and seconds, rounding up and never below zero', () => {
    expect(formatCountdown(600_000)).toBe('10:00')
    expect(formatCountdown(545_100)).toBe('9:06')
    expect(formatCountdown(999)).toBe('0:01')
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-5_000)).toBe('0:00')
  })
})

describe('formatCode', () => {
  it('splits six digits into two groups', () => {
    expect(formatCode('123456')).toBe('123 456')
    expect(formatCode('12345')).toBe('12345')
  })
})

describe('svgDataUri', () => {
  it('encodes the markup so it can go in an img', () => {
    const uri = svgDataUri('<svg viewBox="0 0 1 1"><path d="M0 0h1"/></svg>')
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(uri).not.toContain('<')
    expect(decodeURIComponent(uri.split(',')[1]!)).toContain('<path d="M0 0h1"/>')
  })
})

describe('unreachableHint', () => {
  it('names npm run dev only under the dev server', () => {
    expect(unreachableHint({ mode: 'dev', hostname: 'localhost' })).toContain('npm run dev')
    expect(unreachableHint({ mode: 'app', hostname: 'localhost' })).not.toContain('npm run dev')
  })

  it('sends the Mac back to the app icon', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      expect(isLoopbackHost(hostname)).toBe(true)
      expect(unreachableHint({ hostname })).toContain('from its icon')
    }
  })

  it('tells the phone to check the computer, the app and live mode', () => {
    const hint = unreachableHint({ mode: 'app', hostname: 'MacBook-Pro-van-Joost.local' })
    expect(isLoopbackHost('192.168.1.20')).toBe(false)
    expect(hint).toContain('your computer')
    expect(hint).toContain('Live on Wi-Fi')
    expect(hint).not.toContain('npm')
  })
})
