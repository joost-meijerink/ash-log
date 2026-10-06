<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import { useIntervalFn, useNow } from '@vueuse/core'
import { Check, CircleCheck, Copy, Info, LoaderCircle, QrCode, RefreshCw, ShieldCheck, Smartphone, TriangleAlert } from 'lucide-vue-next'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import IconButton from '@/components/common/IconButton.vue'
import ParchmentPanel from '@/components/common/ParchmentPanel.vue'
import RelativeTime from '@/components/common/RelativeTime.vue'
import SectionHeading from '@/components/common/SectionHeading.vue'
import ToggleChip from '@/components/common/ToggleChip.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { formatDateTime } from '@/composables/useRelativeTime'
import { ANDROID_CA_MENU, CA_CERT_FILE_NAME, PHONE_KINDS } from '@/lib/platform'
import type { PhoneKind, ServerDevice } from '@/lib/types'
import { useServerStore } from '@/stores/server'
import { formatCode, formatCountdown, svgDataUri } from './format'

/**
 * 'Live op wifi' on the computer: the switch, the addresses on the network, pairing a phone and
 * the list of paired devices. Only for the computer itself under the app server. Pairing takes
 * two steps: install the Ash Log certificate (once per device, a QR code to the plain-http
 * certificate page), then pair with a one-time code (a QR code to the https address). Both
 * steps are written for an iPhone or an Android phone, chosen at the top of the section.
 */
const open = defineModel<boolean>('open', { required: true })

const server = useServerStore()
const ids = {
  switch: useId(),
  hint: useId(),
  devices: useId(),
  pair: useId(),
  urls: useId(),
  certificateStep: useId(),
  certificatePanel: useId(),
  pairStep: useId(),
  phone: useId(),
}

/** The switch shows where it is going while the server switches. */
const switchOn = computed(() => server.switchingTo ?? server.live)

// Pairing code countdown. Ticks every second, only while this dialog exists.
const now = useNow({ scheduler: (cb) => useIntervalFn(cb, 1000) })
// Start a fresh code at its full time, not up to a second off.
watch(
  () => server.pairing,
  () => (now.value = new Date()),
)

const remainingMs = computed(() => {
  const expiresAt = server.pairing ? Date.parse(server.pairing.expiresAt) : Number.NaN
  return Number.isNaN(expiresAt) ? 0 : expiresAt - now.value.getTime()
})
const expired = computed(() => !!server.pairing && remainingMs.value <= 0)
const qrSrc = computed(() => (server.pairing ? svgDataUri(server.pairing.qrSvg) : ''))
/** The address in the pairing QR code (it suits the chosen phone), to type when there is no camera. */
const pairingBase = computed(() => /^https?:\/\/[^/?#]+/i.exec(server.pairing?.url ?? '')?.[0] ?? '')

// Step 1: the certificate QR, fetched while this dialog is open and live is on (again when
// another phone is chosen: the address in it can differ).
watch(
  () => [open.value, server.certificateUrl, server.phone] as const,
  ([isOpen, url]) => {
    if (isOpen && url) void server.loadCertificate()
  },
  { immediate: true },
)
const certificateSrc = computed(() => (server.certificate ? svgDataUri(server.certificate.qrSvg) : ''))
const certificateLink = computed(() => server.certificate?.url ?? server.certificateUrl ?? '')

/**
 * One QR code on screen at a time: while a pairing code shows, step 1 folds away behind a
 * button (a phone camera could otherwise pick up the wrong code).
 */
const certificateExpanded = ref(false)
const certificateFolds = computed(() => !!server.pairing)
const certificateOpen = computed(() => !certificateFolds.value || certificateExpanded.value)

// A fresh code folds step 1 and brings the code into view (the dialog scrolls).
const pairingPanel = useTemplateRef<{ $el?: HTMLElement }>('pairingPanel')
watch(
  () => server.pairing?.code,
  async (code) => {
    certificateExpanded.value = false
    if (!code) return
    await nextTick()
    pairingPanel.value?.$el?.scrollIntoView?.({ block: 'nearest' })
  },
)

// Copy an address; the button shows a check for a moment.
const copied = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    copied.value = url
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = null), 2000)
  } catch {
    // No clipboard access: the address is on screen and selects with one click.
  }
}
onBeforeUnmount(() => clearTimeout(copiedTimer))

// Unpair, after a confirm.
const toRevoke = ref<ServerDevice | null>(null)
const confirmOpen = computed({
  get: () => !!toRevoke.value,
  set: (value) => {
    if (!value) toRevoke.value = null
  },
})
function revoke() {
  if (toRevoke.value) void server.revoke(toRevoke.value.id)
}

const PHONE_LABELS: Record<PhoneKind, string> = { iphone: 'iPhone', android: 'Android' }

const CERTIFICATE_STEPS: Record<PhoneKind, string[]> = {
  iphone: [
    'Scan de code en download het profiel op de pagina die opent.',
    'Open Instellingen, tik op Profiel gedownload en installeer het.',
    'Zet Ash Log aan bij Instellingen > Algemeen > Info > Instellingen voor certificaatvertrouwen.',
  ],
  android: [
    'Scan de code en tik op de pagina die opent op Certificaat downloaden.',
    `Open ${ANDROID_CA_MENU.join(' > ')}.`,
    `Tik op Toch installeren en kies ${CA_CERT_FILE_NAME} uit je Downloads.`,
  ],
}

/** Under the steps: what differs per phone. */
const CERTIFICATE_NOTES: Record<PhoneKind, string | null> = {
  iphone: null,
  android: "Heten de menu's op jouw telefoon anders? Zoek in Instellingen op CA-certificaat.",
}

const PAIR_STEPS: Record<PhoneKind, string[]> = {
  iphone: [
    'Scan de code met de camera van je iPhone.',
    'Open de link in Safari. Je iPhone wordt dan gekoppeld.',
    'Tik in Safari op Deel > Zet op beginscherm.',
  ],
  android: [
    'Scan de code met de camera van je telefoon.',
    'Open de link in Chrome. Je telefoon wordt dan gekoppeld.',
    'Tik in Chrome op de drie puntjes > Toevoegen aan startscherm.',
  ],
}

/** The browser to open a link in, as in 'Open ... in Safari op je iPhone'. */
const BROWSER_ON_PHONE: Record<PhoneKind, string> = { iphone: 'Safari op je iPhone', android: 'Chrome op je telefoon' }
const HOME_SCREEN: Record<PhoneKind, string> = {
  iphone: 'tik in Safari op Deel > Zet op beginscherm',
  android: 'tik in Chrome op de drie puntjes > Toevoegen aan startscherm',
}

/** The kind of phone a paired device is, from its name ('iPhone (Safari)', 'Android-telefoon (Chrome)'). */
function deviceKind(device: ServerDevice): PhoneKind {
  if (/^Android/i.test(device.name)) return 'android'
  if (/^(iPhone|iPad|iPod)/.test(device.name)) return 'iphone'
  return server.phone
}

const isWindows = computed(() => server.status?.platform === 'windows')

const noticeClass = 'flex items-start gap-2.5 rounded-md border px-3.5 py-2.5 text-[0.95rem] leading-snug'
const stepBadgeClass =
  'grid size-7 shrink-0 place-content-center rounded-full border border-gold/50 font-display text-[0.8rem] font-semibold text-gold'
const stepTitleClass = 'font-display text-[0.85rem] font-semibold tracking-[0.12em] text-text-light uppercase'
const listBadgeClass =
  'mt-px grid size-5 shrink-0 place-content-center rounded-full border border-gold-ink/40 font-display text-[0.7rem] font-semibold text-gold-ink'
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent data-live-dialog class="gap-5 sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Live op wifi</DialogTitle>
        <DialogDescription>Open het logboek ook op je telefoon, via hetzelfde wifi-netwerk als deze {{ server.computer }}.</DialogDescription>
      </DialogHeader>

      <!-- The switch -->
      <div
        :class="[
          'flex items-start gap-4 rounded-md border px-4 py-2 transition-colors',
          switchOn ? 'border-gold/45 bg-gold/[0.07]' : 'border-line-dark bg-ink/40',
        ]"
      >
        <div class="min-w-0 flex-1">
          <Label :for="ids.switch" class="min-h-11 cursor-pointer font-display text-[0.85rem] font-semibold tracking-[0.12em] uppercase">
            Live op wifi
            <span
              data-slot="live-state"
              aria-hidden="true"
              :class="[
                'font-sans text-sm font-medium tracking-normal normal-case',
                switchOn ? 'text-gold' : 'text-muted-light',
              ]"
            >
              <template v-if="server.switching">{{ server.switchingTo ? 'aanzetten...' : 'uitzetten...' }}</template>
              <template v-else>{{ server.live ? 'staat aan' : 'staat uit' }}</template>
            </span>
          </Label>
          <p :id="ids.hint" class="-mt-1.5 pb-2 text-sm leading-snug text-muted-light">
            Je telefoon kan het logboek openen zolang dit aan staat. Deze {{ server.computer }} gaat dan niet vanzelf slapen. Na een herstart staat het weer uit.
          </p>
        </div>
        <Switch
          :id="ids.switch"
          :aria-describedby="ids.hint"
          :model-value="switchOn"
          :disabled="server.switching"
          class="mt-2.5"
          @update:model-value="(v: boolean) => server.setLive(v)"
        />
      </div>

      <p v-if="server.liveError" role="alert" :class="[noticeClass, 'border-ember/50 bg-ember/10']">
        <TriangleAlert class="mt-0.5 size-4 shrink-0 text-[#e08a6c]" aria-hidden="true" />
        <span>{{ server.liveError }}</span>
      </p>

      <template v-if="server.live">
        <!-- Addresses -->
        <section :aria-labelledby="ids.urls">
          <SectionHeading :id="ids.urls" as="h3" title="Adres op je wifi" />
          <ul class="mt-1 flex flex-col gap-1">
            <li
              v-for="(url, i) in server.urls"
              :key="url"
              data-slot="live-url"
              class="flex min-h-11 items-center gap-2 rounded-md border border-line-dark bg-ink/40 pl-3"
            >
              <span :class="['min-w-0 flex-1 font-mono text-[0.85rem] [overflow-wrap:anywhere] select-all', i === 0 ? 'text-text-light' : 'text-muted-light']">{{ url }}</span>
              <IconButton :label="copied === url ? 'Gekopieerd' : 'Kopieer adres'" size="icon-sm" class="mr-1" @click="copy(url)">
                <Check v-if="copied === url" class="text-gold" />
                <Copy v-else />
              </IconButton>
            </li>
            <li v-if="!server.urls.length" class="text-sm text-muted-light">
              Geen netwerkadres gevonden. Is deze {{ server.computer }} met wifi verbonden?
            </li>
          </ul>
          <p v-if="isWindows" data-slot="live-firewall" class="mt-2 text-sm leading-snug text-muted-light">
            Komt je telefoon er niet bij? Sta Node.js toe als Windows Firewall erom vraagt, en zet je wifi in Windows op Privénetwerk (Instellingen > Netwerk en internet > Wi-Fi > je netwerk).
          </p>
        </section>

        <!-- Pairing, in two steps -->
        <section :aria-labelledby="ids.pair">
          <SectionHeading :id="ids.pair" as="h3" title="Koppel een apparaat" />

          <div role="group" :aria-labelledby="ids.phone" data-slot="live-phone" class="mt-2 flex flex-wrap items-center gap-2">
            <span :id="ids.phone" class="mr-1 text-sm text-muted-light">Welke telefoon?</span>
            <ToggleChip
              v-for="kind in PHONE_KINDS"
              :key="kind"
              tone="dark"
              :data-phone="kind"
              :pressed="server.phone === kind"
              @update:pressed="server.setPhone(kind)"
            >
              {{ PHONE_LABELS[kind] }}
            </ToggleChip>
          </div>

          <ol class="mt-4 flex flex-col gap-5">
            <!-- Step 1: the certificate, once per device -->
            <li data-live-step="certificate" class="flex flex-col gap-2.5">
              <div class="flex min-h-11 items-center gap-3">
                <span aria-hidden="true" :class="stepBadgeClass">1</span>
                <h4 :id="ids.certificateStep" class="min-w-0 flex-1 leading-snug">
                  <span class="sr-only">Stap 1: </span>
                  <span :class="stepTitleClass">Certificaat installeren</span>
                  {{ ' ' }}<span class="text-sm whitespace-nowrap text-muted-light">(eenmalig per apparaat)</span>
                </h4>
                <Button
                  v-if="certificateFolds"
                  variant="ghost"
                  size="sm"
                  data-slot="live-certificate-toggle"
                  :aria-expanded="certificateOpen"
                  :aria-controls="ids.certificatePanel"
                  @click="certificateExpanded = !certificateExpanded"
                >
                  <ShieldCheck aria-hidden="true" />
                  {{ certificateOpen ? 'Verberg QR-code' : 'Toon QR-code' }}
                </Button>
              </div>

              <ParchmentPanel
                v-show="certificateOpen"
                :id="ids.certificatePanel"
                data-live-certificate
                class="flex flex-col gap-4"
              >
                <div class="flex flex-col items-center gap-5 sm:flex-row">
                  <div class="grid size-[204px] shrink-0 place-content-center rounded-md bg-parchment p-3 shadow-[0_0_0_1px_rgba(122,86,26,0.3)]">
                    <img
                      v-if="certificateSrc"
                      :src="certificateSrc"
                      width="180"
                      height="180"
                      alt="QR-code om het certificaat te installeren"
                      class="size-[180px]"
                    />
                    <span v-else-if="server.certificateBusy" role="status" class="flex flex-col items-center gap-2 text-center text-sm text-text-parchment/70">
                      <LoaderCircle class="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      QR-code laden...
                    </span>
                    <QrCode v-else class="size-12 text-gold-ink/30" :stroke-width="1.25" aria-hidden="true" />
                  </div>

                  <div class="flex min-w-0 flex-1 flex-col gap-2">
                    <ol data-slot="live-certificate-steps" class="flex flex-col gap-2 text-[0.95rem] leading-snug">
                      <li v-for="(step, i) in CERTIFICATE_STEPS[server.phone]" :key="`${server.phone}-${i}`" class="flex gap-2.5">
                        <span aria-hidden="true" :class="listBadgeClass">{{ i + 1 }}</span>
                        <span class="min-w-0 [overflow-wrap:anywhere]">{{ step }}</span>
                      </li>
                    </ol>
                    <p v-if="CERTIFICATE_NOTES[server.phone]" class="text-sm leading-snug text-text-parchment/70">{{ CERTIFICATE_NOTES[server.phone] }}</p>
                  </div>
                </div>

                <p v-if="certificateLink" class="border-t border-gold-ink/15 pt-3 text-sm leading-snug text-text-parchment/70">
                  Geen camera bij de hand? Open
                  <span data-slot="live-certificate-url" class="font-mono [overflow-wrap:anywhere] text-text-parchment select-all">{{ certificateLink }}</span>
                  in {{ BROWSER_ON_PHONE[server.phone] }}.
                </p>
              </ParchmentPanel>

              <div v-if="server.certificateError" role="alert" :class="[noticeClass, 'items-center border-ember/50 bg-ember/10']">
                <TriangleAlert class="size-4 shrink-0 text-[#e08a6c]" aria-hidden="true" />
                <span class="min-w-0 flex-1">De QR-code voor het certificaat laden lukt niet: {{ server.certificateError }}</span>
                <Button variant="ghost" size="sm" @click="server.loadCertificate()">Opnieuw</Button>
              </div>
            </li>

            <!-- Step 2: pairing with a one-time code -->
            <li data-live-step="pair" class="flex flex-col gap-2.5">
              <div class="flex min-h-11 items-center gap-3">
                <span aria-hidden="true" :class="stepBadgeClass">2</span>
                <h4 :id="ids.pairStep" class="min-w-0 flex-1 leading-snug">
                  <span class="sr-only">Stap 2: </span>
                  <span :class="stepTitleClass">Koppelen</span>
                </h4>
              </div>

              <div v-if="server.pairedDevice" role="status" :class="[noticeClass, 'border-gold/45 bg-gold/[0.07]']">
                <CircleCheck class="mt-0.5 size-4 shrink-0 text-gold" aria-hidden="true" />
                <span class="min-w-0 flex-1">
                  <strong class="font-semibold">{{ server.pairedDevice.name }}</strong> is gekoppeld. Zet het logboek nu op je
                  beginscherm: {{ HOME_SCREEN[deviceKind(server.pairedDevice)] }}.
                </span>
              </div>

              <ParchmentPanel v-if="server.pairing" ref="pairingPanel" data-live-pairing class="flex flex-col gap-5">
                <div class="flex flex-col items-center gap-5 sm:flex-row">
                  <div class="relative grid size-[244px] shrink-0 place-content-center rounded-md bg-parchment p-3 shadow-[0_0_0_1px_rgba(122,86,26,0.3)]">
                    <img
                      :src="qrSrc"
                      width="220"
                      height="220"
                      :alt="`QR-code om je ${server.phone === 'iphone' ? 'iPhone' : 'telefoon'} te koppelen`"
                      :class="['size-[220px] transition-opacity', expired && 'opacity-15']"
                    />
                    <span
                      v-if="expired"
                      class="absolute inset-0 grid place-content-center font-display text-sm font-semibold tracking-[0.12em] text-text-parchment uppercase"
                    >
                      Verlopen
                    </span>
                  </div>

                  <div class="flex min-w-0 flex-1 flex-col items-center gap-3 text-center sm:items-start sm:text-left">
                    <div>
                      <p class="font-display text-[0.72rem] font-semibold tracking-[0.14em] text-gold-ink uppercase">Code</p>
                      <p
                        data-slot="live-code"
                        :aria-label="`Code ${server.pairing.code.split('').join(' ')}`"
                        :class="[
                          'font-display text-[2.4rem] leading-tight font-semibold tracking-[0.12em] whitespace-nowrap tabular-nums',
                          expired && 'text-text-parchment/40 line-through',
                        ]"
                      >
                        {{ formatCode(server.pairing.code) }}
                      </p>
                      <p class="text-sm text-text-parchment/70" data-slot="live-countdown">
                        <template v-if="expired"><span role="status">Deze code is verlopen.</span></template>
                        <template v-else>Nog <span class="tabular-nums">{{ formatCountdown(remainingMs) }}</span> geldig, één keer te gebruiken.</template>
                      </p>
                    </div>
                    <Button :variant="expired ? 'default' : 'outline'" size="sm" :disabled="server.pairingBusy" @click="server.createPairing()">
                      <LoaderCircle v-if="server.pairingBusy" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      <RefreshCw v-else aria-hidden="true" />
                      Nieuwe code
                    </Button>
                  </div>
                </div>

                <ol data-slot="live-pair-steps" class="flex flex-col gap-2 text-[0.95rem] leading-snug">
                  <li v-for="(step, i) in PAIR_STEPS[server.phone]" :key="`${server.phone}-${i}`" class="flex gap-2.5">
                    <span aria-hidden="true" :class="listBadgeClass">{{ i + 1 }}</span>
                    <span>{{ step }}</span>
                  </li>
                </ol>

                <p v-if="pairingBase" data-slot="live-pairing-url" class="border-t border-gold-ink/15 pt-3 text-sm leading-snug text-text-parchment/70">
                  Geen camera bij de hand? Open <span class="font-mono [overflow-wrap:anywhere] text-text-parchment">{{ pairingBase }}</span> in
                  {{ BROWSER_ON_PHONE[server.phone] }} en typ de code.
                </p>
              </ParchmentPanel>

              <div v-else class="flex flex-col items-start gap-3">
                <p class="text-[0.95rem] leading-snug text-muted-light">
                  Staat het certificaat erop? Koppel het apparaat dan met een code. Daarna opent het logboek daar vanzelf, zolang Live op wifi aan staat.
                </p>
                <Button :disabled="server.pairingBusy" @click="server.createPairing()">
                  <LoaderCircle v-if="server.pairingBusy" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  <QrCode v-else aria-hidden="true" />
                  {{ server.pairedDevice ? 'Nog een apparaat koppelen' : 'Koppel een apparaat' }}
                </Button>
              </div>

              <p v-if="server.pairingError" role="alert" :class="[noticeClass, 'border-ember/50 bg-ember/10']">
                <TriangleAlert class="mt-0.5 size-4 shrink-0 text-[#e08a6c]" aria-hidden="true" />
                <span>Een code maken lukt niet: {{ server.pairingError }}</span>
              </p>
            </li>
          </ol>

          <!-- A home-screen icon that stopped working: this computer got a new address (the icon
               keeps the old one), or the phone was paired over plain http before the certificate existed -->
          <p v-if="server.devices.length" data-slot="live-repair-note" :class="[noticeClass, 'mt-5 border-line-dark bg-ink/40 text-muted-light']">
            <Info class="mt-0.5 size-4 shrink-0 text-gold" aria-hidden="true" />
            <span>
              <strong class="font-semibold text-text-light">Werkt het icoon op je beginscherm niet meer?</strong> Bijvoorbeeld omdat deze
              {{ server.computer }} een ander adres kreeg. Koppel dat apparaat dan opnieuw met een nieuwe code en zet Ash Log weer op je
              beginscherm. Staat het certificaat er nog niet op? Doe dan eerst stap 1.
            </span>
          </p>
        </section>
      </template>

      <!-- Paired devices -->
      <section :aria-labelledby="ids.devices">
        <SectionHeading :id="ids.devices" as="h3" title="Gekoppelde apparaten" :count="server.devices.length || null" />
        <p v-if="!server.devices.length" class="mt-1 text-[0.95rem] text-muted-light">Nog geen apparaten gekoppeld.</p>
        <ul v-else class="mt-1 flex flex-col divide-y divide-line-dark/70">
          <li v-for="device in server.devices" :key="device.id" data-slot="live-device" class="flex items-center gap-3 py-2">
            <Smartphone class="size-5 shrink-0 text-gold" :stroke-width="1.5" aria-hidden="true" />
            <div class="min-w-0 flex-1 leading-snug">
              <p class="truncate font-medium">{{ device.name }}</p>
              <p class="text-sm text-muted-light">
                Gekoppeld op {{ formatDateTime(device.pairedAt) }}<template v-if="device.lastSeenAt">, laatst gezien <RelativeTime :value="device.lastSeenAt" /></template>
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              class="text-[#e08a6c] hover:text-[#f0a488]"
              :disabled="server.revoking === device.id"
              :aria-label="`Ontkoppel ${device.name}`"
              @click="toRevoke = device"
            >
              <LoaderCircle v-if="server.revoking === device.id" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Ontkoppel
            </Button>
          </li>
        </ul>
        <p v-if="server.deviceError" role="alert" :class="[noticeClass, 'mt-2 border-ember/50 bg-ember/10']">
          <TriangleAlert class="mt-0.5 size-4 shrink-0 text-[#e08a6c]" aria-hidden="true" />
          <span>Ontkoppelen lukt niet: {{ server.deviceError }}</span>
        </p>
      </section>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    v-model:open="confirmOpen"
    :title="`${toRevoke?.name ?? 'Apparaat'} ontkoppelen?`"
    description="Dit apparaat kan het logboek dan niet meer openen of bijwerken. Opnieuw koppelen kan altijd."
    confirm-label="Ontkoppel"
    @confirm="revoke"
  />
</template>
