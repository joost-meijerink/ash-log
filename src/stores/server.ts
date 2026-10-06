// 'Live op wifi' and phone pairing: the state of the server behind /api (GET /api/server).
// Under `npm run dev` the status says mode 'dev' and there is nothing to manage. Under the app
// server, the computer itself (local) can switch live mode, pair a phone and unpair devices.
// Pairing takes two steps while live: a phone first installs the Ash Log certificate from the
// plain-http certificate page (once per device, so it trusts the https addresses), then pairs
// with a one-time code. Both QR codes are rendered by the server (GET /api/server/certificate-qr
// and POST /api/server/pairing), so the qrcode package stays out of the app bundle. They are
// made for one kind of phone (iPhone or Android, chosen in the live dialog): the steps differ,
// and so may the address in them.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, type CertificateQr } from '@/lib/api'
import { computerNoun, parsePhoneKind } from '@/lib/platform'
import type { PairingCode, PhoneKind, ServerDevice, ServerStatus } from '@/lib/types'

/** Status refresh while the live dialog is open, so a freshly paired phone shows up. */
export const LIVE_POLL_MS = 5000

/** After a live switch the server swaps its listeners; check shortly after that it stuck. */
export const VERIFY_DELAY_MS = 1200
const VERIFY_TRIES = 3

/**
 * The certificate QR is asked for right when live goes on, while the server still swaps its
 * listeners and issues its certificate. Try a few times, VERIFY_DELAY_MS apart.
 */
const CERTIFICATE_TRIES = 3

/** Where this browser remembers the phone chosen in the live dialog (a convenience only). */
export const PHONE_STORAGE_KEY = 'ash-log:live-phone'

function readPhone(): PhoneKind {
  try {
    return parsePhoneKind(globalThis.localStorage?.getItem(PHONE_STORAGE_KEY)) ?? 'iphone'
  } catch {
    return 'iphone'
  }
}

function rememberPhone(phone: PhoneKind) {
  try {
    globalThis.localStorage?.setItem(PHONE_STORAGE_KEY, phone)
  } catch {
    // Private mode or blocked storage: the choice lasts until the page reloads.
  }
}

/** The mDNS name (.local) first, the IP addresses after it; otherwise the server's order. */
export function sortUrls(urls: readonly string[]): string[] {
  const isLocalName = (url: string) => {
    try {
      return new URL(url).hostname.endsWith('.local')
    } catch {
      return false
    }
  }
  return [...urls.filter(isLocalName), ...urls.filter((u) => !isLocalName(u))]
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const useServerStore = defineStore('server', () => {
  const status = ref<ServerStatus | null>(null)
  /** The last status request failed (unreachable, or an older middleware without /api/server). */
  const error = ref<string | null>(null)
  const loading = ref(false)

  /** The state a live switch that is on its way asked for; null when none is. */
  const switchingTo = ref<boolean | null>(null)
  const switching = computed(() => switchingTo.value !== null)
  /** Why the last live switch failed, e.g. the port is taken. */
  const liveError = ref<string | null>(null)

  /** The one-time code on screen. */
  const pairing = ref<PairingCode | null>(null)
  const pairingBusy = ref(false)
  const pairingError = ref<string | null>(null)
  /** The device that paired with the code on screen (that code is used up now). */
  const pairedDevice = ref<ServerDevice | null>(null)

  /** The phone the steps and QR codes are for. */
  const phone = ref<PhoneKind>(readPhone())

  /** QR code for the certificate page (step 1 of pairing), fetched while live. */
  const certificate = ref<CertificateQr | null>(null)
  const certificateBusy = ref(false)
  const certificateError = ref<string | null>(null)

  /** Id of the device being unpaired. */
  const revoking = ref<string | null>(null)
  const deviceError = ref<string | null>(null)

  /** Only the computer itself, under the app server, manages live mode and devices. */
  const canManage = computed(() => status.value?.mode === 'app' && status.value.local)
  /** How texts name the computer the server runs on: 'Mac', 'pc' or 'computer'. */
  const computer = computed(() => computerNoun(status.value?.platform))
  const live = computed(() => !!status.value?.live)
  /**
   * A server that names its platform puts the address an iPhone gets first (the LAN address on
   * Windows and Linux, or as LIVE_ADDRESS says); an older one gets the .local name first.
   */
  const urls = computed(() => {
    const list = status.value?.urls ?? []
    return status.value?.platform ? [...list] : sortUrls(list)
  })
  const devices = computed(() => status.value?.devices ?? [])
  /** While live: the plain-http page where a phone installs the certificate. */
  const certificateUrl = computed(() => (status.value?.live && status.value.certificateUrl) || null)

  // A status request that was already under way when a change started may carry the old
  // state. Changes bump the generation, and a load only applies when it is still current.
  let generation = 0
  let pending = 0
  /** Device ids that existed when the code on screen was made. */
  let knownAtPairing = new Set<string>()
  let verifyTimer: ReturnType<typeof setTimeout> | undefined
  /** Bumped by every certificate request and by clearing it; an older request then stops. */
  let certificateRun = 0
  /** certificateUrl and phone the QR on screen (or the request on its way) belongs to. */
  let certificateFor: string | null = null

  function apply(next: ServerStatus) {
    status.value = next
    if (!next.live) {
      pairing.value = null
      clearCertificate()
    }
    if (pairing.value && next.devices) {
      const fresh = next.devices.find((d) => !knownAtPairing.has(d.id))
      if (fresh) {
        pairedDevice.value = fresh
        pairing.value = null
      }
    }
  }

  async function mutate<T>(run: () => Promise<T>): Promise<T> {
    generation++
    pending++
    try {
      return await run()
    } finally {
      pending--
      generation++
    }
  }

  /** Fetches the status. Resolves to false when that failed or was overtaken by a change. */
  async function load(): Promise<boolean> {
    if (pending) return false
    const started = generation
    loading.value = true
    try {
      const next = await api.serverStatus()
      if (started !== generation || pending) return false
      apply(next)
      error.value = null
      return true
    } catch (err) {
      if (started === generation) error.value = message(err)
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * The server answers a live switch before it swaps its listeners, so a failure to listen
   * shows up only in the next status. Check once it settled, with a retry or two while the
   * listeners come back up.
   */
  function verifyLive(expected: boolean, triesLeft = VERIFY_TRIES) {
    if (verifyTimer) clearTimeout(verifyTimer)
    verifyTimer = setTimeout(async () => {
      verifyTimer = undefined
      const ok = await load()
      if (!ok) {
        if (triesLeft > 1 && !pending) verifyLive(expected, triesLeft - 1)
        return
      }
      if (status.value && status.value.live !== expected && !liveError.value) {
        liveError.value = expected
          ? 'Live aanzetten is niet gelukt. Probeer het nog eens.'
          : 'Live uitzetten is niet gelukt. Probeer het nog eens.'
      }
    }, VERIFY_DELAY_MS)
  }

  async function setLive(on: boolean) {
    if (switching.value) return
    switchingTo.value = on
    liveError.value = null
    if (verifyTimer) clearTimeout(verifyTimer)
    try {
      await mutate(async () => apply(await api.setLive(on)))
      if (!on) clearPairing()
      verifyLive(on)
    } catch (err) {
      liveError.value = message(err)
    } finally {
      switchingTo.value = null
    }
  }

  /** Asks for a fresh one-time code for the chosen phone; an older code on screen is replaced. */
  async function createPairing() {
    if (pairingBusy.value) return
    pairingBusy.value = true
    pairingError.value = null
    pairedDevice.value = null
    try {
      const code = await mutate(() => api.createPairing(phone.value))
      knownAtPairing = new Set(devices.value.map((d) => d.id))
      pairing.value = code
    } catch (err) {
      pairingError.value = message(err)
    } finally {
      pairingBusy.value = false
    }
  }

  /**
   * Fetches the certificate QR for the current certificateUrl while live, unless that one is on
   * screen or on its way already. A failure shows only after the last try.
   */
  async function loadCertificate(): Promise<void> {
    const url = certificateUrl.value
    if (!url) return clearCertificate()
    const key = `${phone.value} ${url}`
    if (certificateFor === key && (certificate.value || certificateBusy.value)) return
    const run = ++certificateRun
    certificateFor = key
    certificate.value = null
    certificateError.value = null
    certificateBusy.value = true
    for (let attempt = 1; ; attempt++) {
      try {
        const qr = await api.certificateQr(phone.value)
        if (run !== certificateRun) return
        certificate.value = qr
        break
      } catch (err) {
        if (run !== certificateRun) return
        if (attempt >= CERTIFICATE_TRIES) {
          certificateError.value = message(err)
          // Unlocks a retry for the same address.
          certificateFor = null
          break
        }
      }
      await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS))
      if (run !== certificateRun) return
    }
    certificateBusy.value = false
  }

  /**
   * Shows the steps and QR codes for another kind of phone. The QR codes on screen were made
   * for the other one, so they go: the certificate QR loads again (the dialog asks for it), and
   * a pairing code on screen is swapped for a fresh one.
   */
  function setPhone(next: PhoneKind) {
    if (next === phone.value) return
    phone.value = next
    rememberPhone(next)
    clearCertificate()
    if (pairing.value) {
      pairing.value = null
      void createPairing()
    }
  }

  /** Forgets the certificate QR (live went off); a request on its way is dropped. */
  function clearCertificate() {
    certificateRun++
    certificateFor = null
    certificate.value = null
    certificateBusy.value = false
    certificateError.value = null
  }

  /** Forgets the code and the pairing result on screen (the dialog closed, or live went off). */
  function clearPairing() {
    pairing.value = null
    pairedDevice.value = null
    pairingError.value = null
  }

  async function revoke(id: string) {
    if (revoking.value) return
    revoking.value = id
    deviceError.value = null
    try {
      await mutate(async () => apply(await api.revokeDevice(id)))
      if (pairedDevice.value?.id === id) pairedDevice.value = null
    } catch (err) {
      deviceError.value = message(err)
    } finally {
      revoking.value = null
    }
  }

  return {
    status,
    error,
    loading,
    switchingTo,
    switching,
    liveError,
    pairing,
    pairingBusy,
    pairingError,
    pairedDevice,
    phone,
    certificate,
    certificateBusy,
    certificateError,
    revoking,
    deviceError,
    canManage,
    computer,
    live,
    urls,
    devices,
    certificateUrl,
    load,
    setLive,
    createPairing,
    clearPairing,
    setPhone,
    loadCertificate,
    revoke,
  }
})
