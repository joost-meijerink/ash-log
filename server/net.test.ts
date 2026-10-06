import { describe, expect, it } from 'vitest'
import { parsePort } from './config.ts'
import type { NetworkInterfaceInfo } from 'node:os'
import {
  allowedHosts,
  certificateUrl,
  createLanHostname,
  hostAllowed,
  interfaceRank,
  isLoopback,
  isPrivateIpv4,
  isUsableLocalName,
  lanAddresses,
  liveAddressSetting,
  liveUrls,
  mdnsName,
  normalizeAddress,
  phoneHosts,
  readLocalHostName,
} from './net.ts'

describe('isLoopback', () => {
  it('accepts only the loopback socket addresses', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a), a).toBe(true)
    for (const a of ['192.168.1.20', '::ffff:192.168.1.20', 'fe80::1', '0.0.0.0', '', undefined]) expect(isLoopback(a), String(a)).toBe(false)
  })
})

describe('normalizeAddress', () => {
  it('strips the IPv4-mapped prefix', () => {
    expect(normalizeAddress('::ffff:192.168.1.20')).toBe('192.168.1.20')
    expect(normalizeAddress('fe80::1')).toBe('fe80::1')
    expect(normalizeAddress(undefined)).toBe('onbekend')
  })
})

describe('names and urls', () => {
  it('keeps a hostname that already ends in .local', () => {
    expect(mdnsName('MacBook-Pro-van-Joost.local')).toBe('MacBook-Pro-van-Joost.local')
    expect(mdnsName('studio')).toBe('studio.local')
    expect(mdnsName('joost-mbp.home')).toBe('joost-mbp.local')
  })

  it('uses the Bonjour name, not a hostname the router handed out', () => {
    let clock = 0
    let reads = 0
    let local: string | null = 'MacBook-Pro-van-Joost'
    const name = createLanHostname({
      platform: 'darwin',
      readLocalHostName: () => {
        reads++
        return local
      },
      osHostname: () => 'mbp-van-joost.home',
      now: () => clock,
      ttlMs: 30_000,
    })
    expect(name()).toBe('MacBook-Pro-van-Joost.local')
    expect(mdnsName(name())).toBe('MacBook-Pro-van-Joost.local')
    // Cached for a while, then read again (the name can change in System Settings).
    local = 'Studio'
    expect(name()).toBe('MacBook-Pro-van-Joost.local')
    expect(reads).toBe(1)
    clock += 30_000
    expect(name()).toBe('Studio.local')
    // No Bonjour name (not a Mac): os.hostname().
    local = null
    clock += 30_000
    expect(name()).toBe('mbp-van-joost.home')
  })

  it('lists https urls, the mDNS name first, then the private LAN addresses', () => {
    expect(liveUrls(5199, 'MacBook-Pro-van-Joost.local', ['192.168.1.20', '10.0.0.5'])).toEqual([
      'https://MacBook-Pro-van-Joost.local:5199',
      'https://192.168.1.20:5199',
      'https://10.0.0.5:5199',
    ])
    // A VPN or CGNAT address cannot be in the certificate, so it is not offered.
    expect(liveUrls(5199, 'studio', ['100.64.0.7', '172.20.1.2', '8.8.8.8'])).toEqual(['https://studio.local:5199', 'https://172.20.1.2:5199'])
  })

  it('puts the certificate page on plain http and the mDNS name', () => {
    expect(certificateUrl(5199, 'MacBook-Pro-van-Joost.local')).toBe('http://MacBook-Pro-van-Joost.local:5199/certificaat')
    expect(certificateUrl(5200, 'joost-mbp.home')).toBe('http://joost-mbp.local:5200/certificaat')
  })

  it('knows the private IPv4 ranges', () => {
    for (const ip of ['127.0.0.1', '127.255.0.9', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.255.255']) {
      expect(isPrivateIpv4(ip), ip).toBe(true)
    }
    for (const ip of ['172.15.255.255', '172.32.0.1', '192.169.0.1', '11.0.0.1', '100.64.0.1', '169.254.1.1', '8.8.8.8', '::1', 'fe80::1', '', 'x']) {
      expect(isPrivateIpv4(ip), ip).toBe(false)
    }
  })
})

describe('names on Windows and Linux', () => {
  it('uses the Windows computer name in lower case, without asking scutil', () => {
    const name = createLanHostname({ platform: 'win32', osHostname: () => 'DESKTOP-AB12CD' })
    expect(name()).toBe('desktop-ab12cd')
    expect(mdnsName(name())).toBe('desktop-ab12cd.local')
  })

  it('uses os.hostname() on Linux and has no Bonjour name there', () => {
    expect(createLanHostname({ platform: 'linux', osHostname: () => 'steamdeck' })()).toBe('steamdeck')
    expect(readLocalHostName('win32')).toBeNull()
    expect(readLocalHostName('linux')).toBeNull()
  })

  it('knows which .local names a phone can resolve', () => {
    for (const ok of ['desktop-ab12cd.local', 'MacBook-Pro-van-Joost.local', 'a.local', 'pc-1.home.local']) expect(isUsableLocalName(ok), ok).toBe(true)
    for (const bad of ['joost_pc.local', 'pc-van-jöst.local', '-pc.local', 'pc-.local', 'local', 'pc.lan', '.local', 'pc..local']) {
      expect(isUsableLocalName(bad), bad).toBe(false)
    }
  })
})

describe('LAN addresses', () => {
  const v4 = (address: string, mac = 'aa:bb:cc:dd:ee:ff', internal = false): NetworkInterfaceInfo => ({
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac,
    internal,
    cidr: `${address}/24`,
  })
  const v6 = (address: string): NetworkInterfaceInfo => ({ address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: `${address}/64`, scopeid: 0 })

  it('puts Wi-Fi and Ethernet before Hyper-V, WSL, VirtualBox and the hotspot on Windows', () => {
    const addresses = lanAddresses(() => ({
      'vEthernet (Default Switch)': [v4('172.29.96.1', '00:15:5d:01:02:03')],
      'vEthernet (WSL (Hyper-V firewall))': [v4('172.18.0.1')],
      'VirtualBox Host-Only Network': [v4('192.168.56.1', '0a:00:27:00:00:0c')],
      'Local Area Connection* 10': [v4('192.168.137.1')],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', '00:00:00:00:00:00', true)],
      'Wi-Fi': [v6('fe80::1'), v4('192.168.1.23'), v4('169.254.10.10')],
      'Ethernet 2': [v4('10.0.0.8')],
    }))
    expect(addresses.slice(0, 2)).toEqual(['192.168.1.23', '10.0.0.8'])
    expect(addresses).toHaveLength(6)
    expect(addresses).not.toContain('127.0.0.1')
    expect(addresses).not.toContain('169.254.10.10')
  })

  it('puts en0 before bridges and VPN tunnels on macOS, and wlan before docker on Linux', () => {
    expect(lanAddresses(() => ({ bridge100: [v4('192.168.2.1')], utun4: [v4('10.8.0.2')], en0: [v4('192.168.1.20')] }))[0]).toBe('192.168.1.20')
    expect(lanAddresses(() => ({ docker0: [v4('172.17.0.1', '02:42:ac:11:00:02')], 'br-1a2b': [v4('172.18.0.1')], wlp2s0: [v4('192.168.1.40')] }))[0]).toBe('192.168.1.40')
  })

  it('ranks adapters by name and by the hardware address of virtual machines', () => {
    for (const name of ['en0', 'en7', 'eth0', 'wlan0', 'wlp2s0', 'enp3s0', 'eno1', 'Wi-Fi', 'WLAN', 'Ethernet', 'Ethernet 3', 'Wireless Network Connection', 'Local Area Connection']) {
      expect(interfaceRank(name), name).toBe(0)
    }
    for (const name of ['vEthernet (WSL)', 'VMware Network Adapter VMnet8', 'Local Area Connection* 2', 'Bluetooth Network Connection', 'tailscale0', 'docker0', 'utun3', 'bridge100', 'NordLynx VPN']) {
      expect(interfaceRank(name), name).toBe(2)
    }
    expect(interfaceRank('Ethernet 5', '00:50:56:C0:00:08')).toBe(2)
    expect(interfaceRank('Realtek USB')).toBe(1)
  })

  it('reads the real interfaces without throwing', () => {
    for (const ip of lanAddresses()) expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  })
})

describe('the address phones get', () => {
  it('follows LIVE_ADDRESS from .env, any case, and ignores anything else', () => {
    expect(liveAddressSetting({ LIVE_ADDRESS: 'name' })).toBe('name')
    expect(liveAddressSetting({ LIVE_ADDRESS: ' IP ' })).toBe('ip')
    expect(liveAddressSetting({ LIVE_ADDRESS: 'naam' })).toBeNull()
    expect(liveAddressSetting({ LIVE_ADDRESS: '' })).toBeNull()
    expect(liveAddressSetting({})).toBeNull()
  })

  it('puts the LAN address first in ip mode, with the .local name as the last option', () => {
    expect(liveUrls(5199, 'desktop-ab12cd', ['192.168.1.23', '10.0.0.8'], 'ip')).toEqual([
      'https://192.168.1.23:5199',
      'https://10.0.0.8:5199',
      'https://desktop-ab12cd.local:5199',
    ])
    expect(certificateUrl(5199, 'desktop-ab12cd', ['192.168.1.23'], 'ip')).toBe('http://192.168.1.23:5199/certificaat')
  })

  it('takes an IPv4 address in place of the name (app.ts passes the host a phone should use)', () => {
    expect(mdnsName('192.168.1.23')).toBe('192.168.1.23')
    expect(certificateUrl(5199, '192.168.1.23')).toBe('http://192.168.1.23:5199/certificaat')
    expect(phoneHosts(5199, '192.168.1.23', ['10.0.0.8', '192.168.1.23'])).toEqual(['192.168.1.23:5199', '10.0.0.8:5199'])
    expect(certificateUrl(5199, 'MacBook-Pro-van-Joost.local')).toBe('http://MacBook-Pro-van-Joost.local:5199/certificaat')
  })

  it('falls back to the .local name when there is no private LAN address', () => {
    expect(liveUrls(5199, 'desktop-ab12cd', [], 'ip')).toEqual(['https://desktop-ab12cd.local:5199'])
    expect(liveUrls(5199, 'desktop-ab12cd', ['100.64.0.7'], 'ip')).toEqual(['https://desktop-ab12cd.local:5199'])
    expect(certificateUrl(5199, 'desktop-ab12cd', [], 'ip')).toBe('http://desktop-ab12cd.local:5199/certificaat')
  })

  it('never puts a .local name a phone cannot resolve first', () => {
    expect(liveUrls(5199, 'joost_pc', ['192.168.1.23'], 'name')).toEqual(['https://192.168.1.23:5199', 'https://joost_pc.local:5199'])
    expect(certificateUrl(5199, 'joost_pc', ['192.168.1.23'])).toBe('http://192.168.1.23:5199/certificaat')
  })

  it('keeps the name first in name mode, as on the Mac today', () => {
    expect(liveUrls(5199, 'MacBook-Pro-van-Joost.local', ['192.168.1.20'], 'name')[0]).toBe('https://MacBook-Pro-van-Joost.local:5199')
    expect(certificateUrl(5199, 'MacBook-Pro-van-Joost.local', ['192.168.1.20'])).toBe('http://MacBook-Pro-van-Joost.local:5199/certificaat')
    expect(liveUrls(5199, 'studio', ['192.168.1.20', '192.168.1.20'])).toEqual(['https://studio.local:5199', 'https://192.168.1.20:5199'])
  })
})

describe('Host header check', () => {
  const allowed = allowedHosts(5199, 'MacBook-Pro-van-Joost.local', ['192.168.1.20'])

  it('allows localhost, loopback, the Mac name (any case) and LAN addresses with the port', () => {
    for (const host of ['localhost:5199', '127.0.0.1:5199', '[::1]:5199', 'macbook-pro-van-joost.local:5199', 'MacBook-Pro-van-Joost.local:5199', '192.168.1.20:5199']) {
      expect(hostAllowed(host, allowed), host).toBe(true)
    }
  })

  it('also allows the raw hostname when it is not the .local name', () => {
    const dhcp = allowedHosts(5199, 'joost-mbp.home', [])
    expect(hostAllowed('joost-mbp.home:5199', dhcp)).toBe(true)
    expect(hostAllowed('joost-mbp.local:5199', dhcp)).toBe(true)
  })

  it('allows the Bonjour name and the DHCP hostname side by side', () => {
    const both = allowedHosts(5199, 'MacBook-Pro-van-Joost.local', ['192.168.2.2'], ['mbp-van-joost.home'])
    for (const host of ['macbook-pro-van-joost.local:5199', 'mbp-van-joost.home:5199', '192.168.2.2:5199']) {
      expect(hostAllowed(host, both), host).toBe(true)
    }
    // Nobody answers to a .local made up from the DHCP name, so it is not allowed either.
    for (const host of ['mbp-van-joost.local:5199', 'evil.example:5199']) expect(hostAllowed(host, both), host).toBe(false)
  })

  it('refuses foreign names, other ports and a missing header', () => {
    for (const host of ['evil.example:5199', 'localhost', 'localhost:80', '192.168.1.21:5199', 'localhost.:5199', '']) {
      expect(hostAllowed(host, allowed), host).toBe(false)
    }
    expect(hostAllowed(undefined, allowed)).toBe(false)
  })
})

describe('parsePort', () => {
  it('defaults to 5199 and refuses anything that is not a port', () => {
    expect(parsePort(undefined)).toBe(5199)
    expect(parsePort(' ')).toBe(5199)
    expect(parsePort('5200')).toBe(5200)
    for (const bad of ['0', '65536', 'abc', '51.5', '-1', '5199x']) expect(() => parsePort(bad), bad).toThrow(/geen geldige poort/)
  })
})
