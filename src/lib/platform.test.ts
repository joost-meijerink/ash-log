import { describe, expect, it } from 'vitest'
import { ANDROID_CA_MENU, CA_CERT_FILE_NAME, computerNoun, parsePhoneKind, phoneFromUserAgent, serverPlatform } from './platform'

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  ipadMobile: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  // iPadOS Safari asks for desktop sites and says it is a Mac.
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  pixel: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
}

describe('the computer', () => {
  it('maps process.platform to the status platform', () => {
    expect(serverPlatform('darwin')).toBe('mac')
    expect(serverPlatform('win32')).toBe('windows')
    expect(serverPlatform('linux')).toBe('linux')
    expect(serverPlatform('freebsd')).toBe('other')
  })

  it('names it Mac, PC or computer', () => {
    expect(computerNoun('mac')).toBe('Mac')
    expect(computerNoun('windows')).toBe('PC')
    expect(computerNoun('linux')).toBe('computer')
    expect(computerNoun('other')).toBe('computer')
    // An older server without the field.
    expect(computerNoun(undefined)).toBe('computer')
  })
})

describe('the phone', () => {
  it('tells an iPhone from an Android phone by its user agent', () => {
    expect(phoneFromUserAgent(UA.iphone)).toBe('iphone')
    expect(phoneFromUserAgent(UA.ipadMobile)).toBe('iphone')
    expect(phoneFromUserAgent(UA.pixel)).toBe('android')
    expect(phoneFromUserAgent(UA.samsung)).toBe('android')
    for (const ua of [UA.ipadDesktop, UA.windows, '', undefined]) expect(phoneFromUserAgent(ua), String(ua)).toBeNull()
  })

  it('accepts only the two phone kinds from a request', () => {
    expect(parsePhoneKind('iphone')).toBe('iphone')
    expect(parsePhoneKind('android')).toBe('android')
    for (const value of ['Android', 'ios', '', null, undefined, 1, ['android']]) expect(parsePhoneKind(value), String(value)).toBeNull()
  })

  it('has the Android menu path and the file name the steps name', () => {
    expect(ANDROID_CA_MENU.join(' > ')).toBe(
      'Settings > Security & privacy > More security settings > Encryption & credentials > Install a certificate > CA certificate',
    )
    expect(CA_CERT_FILE_NAME).toBe('ash-log-ca.crt')
  })
})
