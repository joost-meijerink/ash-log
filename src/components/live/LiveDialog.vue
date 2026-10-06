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
 * 'Live on Wi-Fi' on the computer: the switch, the addresses on the network, pairing a phone and
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
    'Scan the code, tap Download Profile on the page that opens, then Allow.',
    'Open Settings, tap Profile Downloaded and install it.',
    'Turn on Ash Log under Settings > General > About > Certificate Trust Settings.',
  ],
  android: [
    'Scan the code and tap Download certificate on the page that opens.',
    `Open ${ANDROID_CA_MENU.join(' > ')}.`,
    `Tap Install anyway and pick ${CA_CERT_FILE_NAME} from your Downloads.`,
  ],
}

/** Under the steps: what differs per phone. */
const CERTIFICATE_NOTES: Record<PhoneKind, string | null> = {
  iphone: null,
  android: "Menus named differently on your phone? Search Settings for 'CA certificate'.",
}

const PAIR_STEPS: Record<PhoneKind, string[]> = {
  iphone: [
    'Scan the code with the camera of your iPhone.',
    'Open the link in Safari. That pairs your iPhone.',
    'In Safari, tap Share > Add to Home Screen.',
  ],
  android: [
    'Scan the code with the camera of your phone.',
    'Open the link in Chrome. That pairs your phone.',
    'In Chrome, tap the three dots > Add to Home screen.',
  ],
}

/** The browser to open a link in, as in 'Open ... in Safari on your iPhone'. */
const BROWSER_ON_PHONE: Record<PhoneKind, string> = { iphone: 'Safari on your iPhone', android: 'Chrome on your phone' }
const HOME_SCREEN: Record<PhoneKind, string> = {
  iphone: 'in Safari, tap Share > Add to Home Screen',
  android: 'in Chrome, tap the three dots > Add to Home screen',
}

/** The kind of phone a paired device is, from its name ('iPhone (Safari)', 'Android phone (Chrome)'). */
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
        <DialogTitle>Live on Wi-Fi</DialogTitle>
        <DialogDescription>Open Ash Log on your phone too, over the same Wi-Fi network as this {{ server.computer }}.</DialogDescription>
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
            Live on Wi-Fi
            <span
              data-slot="live-state"
              aria-hidden="true"
              :class="[
                'font-sans text-sm font-medium tracking-normal normal-case',
                switchOn ? 'text-gold' : 'text-muted-light',
              ]"
            >
              <template v-if="server.switching">{{ server.switchingTo ? 'turning on...' : 'turning off...' }}</template>
              <template v-else>{{ server.live ? 'on' : 'off' }}</template>
            </span>
          </Label>
          <p :id="ids.hint" class="-mt-1.5 pb-2 text-sm leading-snug text-muted-light">
            Your phone can open Ash Log while this is on. This {{ server.computer }} won't go to sleep on its own in the meantime. After a restart, it's off again.
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
          <SectionHeading :id="ids.urls" as="h3" title="Address on your Wi-Fi" />
          <ul class="mt-1 flex flex-col gap-1">
            <li
              v-for="(url, i) in server.urls"
              :key="url"
              data-slot="live-url"
              class="flex min-h-11 items-center gap-2 rounded-md border border-line-dark bg-ink/40 pl-3"
            >
              <span :class="['min-w-0 flex-1 font-mono text-[0.85rem] [overflow-wrap:anywhere] select-all', i === 0 ? 'text-text-light' : 'text-muted-light']">{{ url }}</span>
              <IconButton :label="copied === url ? 'Copied' : 'Copy address'" size="icon-sm" class="mr-1" @click="copy(url)">
                <Check v-if="copied === url" class="text-gold" />
                <Copy v-else />
              </IconButton>
            </li>
            <li v-if="!server.urls.length" class="text-sm text-muted-light">
              No network address found. Is this {{ server.computer }} connected to Wi-Fi?
            </li>
          </ul>
          <p v-if="isWindows" data-slot="live-firewall" class="mt-2 text-sm leading-snug text-muted-light">
            Phone can't connect? Allow Node.js when Windows Firewall asks, and set your Wi-Fi in Windows to Private network (Settings > Network &amp; internet > Wi-Fi > your network > Network profile type).
          </p>
        </section>

        <!-- Pairing, in two steps -->
        <section :aria-labelledby="ids.pair">
          <SectionHeading :id="ids.pair" as="h3" title="Pair a device" />

          <div role="group" :aria-labelledby="ids.phone" data-slot="live-phone" class="mt-2 flex flex-wrap items-center gap-2">
            <span :id="ids.phone" class="mr-1 text-sm text-muted-light">Which phone?</span>
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
                  <span class="sr-only">Step 1: </span>
                  <span :class="stepTitleClass">Install the certificate</span>
                  {{ ' ' }}<span class="text-sm whitespace-nowrap text-muted-light">(once per device)</span>
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
                  {{ certificateOpen ? 'Hide QR code' : 'Show QR code' }}
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
                      alt="QR code to install the certificate"
                      class="size-[180px]"
                    />
                    <span v-else-if="server.certificateBusy" role="status" class="flex flex-col items-center gap-2 text-center text-sm text-text-parchment/70">
                      <LoaderCircle class="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      Loading QR code...
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
                  No camera at hand? Open
                  <span data-slot="live-certificate-url" class="font-mono [overflow-wrap:anywhere] text-text-parchment select-all">{{ certificateLink }}</span>
                  in {{ BROWSER_ON_PHONE[server.phone] }}.
                </p>
              </ParchmentPanel>

              <div v-if="server.certificateError" role="alert" :class="[noticeClass, 'items-center border-ember/50 bg-ember/10']">
                <TriangleAlert class="size-4 shrink-0 text-[#e08a6c]" aria-hidden="true" />
                <span class="min-w-0 flex-1">Couldn't load the certificate QR code: {{ server.certificateError }}</span>
                <Button variant="ghost" size="sm" @click="server.loadCertificate()">Try again</Button>
              </div>
            </li>

            <!-- Step 2: pairing with a one-time code -->
            <li data-live-step="pair" class="flex flex-col gap-2.5">
              <div class="flex min-h-11 items-center gap-3">
                <span aria-hidden="true" :class="stepBadgeClass">2</span>
                <h4 :id="ids.pairStep" class="min-w-0 flex-1 leading-snug">
                  <span class="sr-only">Step 2: </span>
                  <span :class="stepTitleClass">Pair</span>
                </h4>
              </div>

              <div v-if="server.pairedDevice" role="status" :class="[noticeClass, 'border-gold/45 bg-gold/[0.07]']">
                <CircleCheck class="mt-0.5 size-4 shrink-0 text-gold" aria-hidden="true" />
                <span class="min-w-0 flex-1">
                  <strong class="font-semibold">{{ server.pairedDevice.name }}</strong> is paired. Now put Ash Log on your
                  home screen: {{ HOME_SCREEN[deviceKind(server.pairedDevice)] }}.
                </span>
              </div>

              <ParchmentPanel v-if="server.pairing" ref="pairingPanel" data-live-pairing class="flex flex-col gap-5">
                <div class="flex flex-col items-center gap-5 sm:flex-row">
                  <div class="relative grid size-[244px] shrink-0 place-content-center rounded-md bg-parchment p-3 shadow-[0_0_0_1px_rgba(122,86,26,0.3)]">
                    <img
                      :src="qrSrc"
                      width="220"
                      height="220"
                      :alt="`QR code to pair your ${server.phone === 'iphone' ? 'iPhone' : 'phone'}`"
                      :class="['size-[220px] transition-opacity', expired && 'opacity-15']"
                    />
                    <span
                      v-if="expired"
                      class="absolute inset-0 grid place-content-center font-display text-sm font-semibold tracking-[0.12em] text-text-parchment uppercase"
                    >
                      Expired
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
                        <template v-if="expired"><span role="status">This code has expired.</span></template>
                        <template v-else>Valid for <span class="tabular-nums">{{ formatCountdown(remainingMs) }}</span> more, works once.</template>
                      </p>
                    </div>
                    <Button :variant="expired ? 'default' : 'outline'" size="sm" :disabled="server.pairingBusy" @click="server.createPairing()">
                      <LoaderCircle v-if="server.pairingBusy" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      <RefreshCw v-else aria-hidden="true" />
                      New code
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
                  No camera at hand? Open <span class="font-mono [overflow-wrap:anywhere] text-text-parchment">{{ pairingBase }}</span> in
                  {{ BROWSER_ON_PHONE[server.phone] }} and type the code.
                </p>
              </ParchmentPanel>

              <div v-else class="flex flex-col items-start gap-3">
                <p class="text-[0.95rem] leading-snug text-muted-light">
                  Certificate installed? Then pair the device with a code. After that, Ash Log opens there by itself, as long as Live on Wi-Fi is on.
                </p>
                <Button :disabled="server.pairingBusy" @click="server.createPairing()">
                  <LoaderCircle v-if="server.pairingBusy" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  <QrCode v-else aria-hidden="true" />
                  {{ server.pairedDevice ? 'Pair another device' : 'Pair a device' }}
                </Button>
              </div>

              <p v-if="server.pairingError" role="alert" :class="[noticeClass, 'border-ember/50 bg-ember/10']">
                <TriangleAlert class="mt-0.5 size-4 shrink-0 text-[#e08a6c]" aria-hidden="true" />
                <span>Couldn't make a code: {{ server.pairingError }}</span>
              </p>
            </li>
          </ol>

          <!-- A home-screen icon that stopped working: this computer got a new address (the icon
               keeps the old one), or the phone was paired over plain http before the certificate existed -->
          <p v-if="server.devices.length" data-slot="live-repair-note" :class="[noticeClass, 'mt-5 border-line-dark bg-ink/40 text-muted-light']">
            <Info class="mt-0.5 size-4 shrink-0 text-gold" aria-hidden="true" />
            <span>
              <strong class="font-semibold text-text-light">Home screen icon stopped working?</strong> For example because this
              {{ server.computer }} got a new address. Then pair that device again with a new code and put Ash Log back on your
              home screen. Certificate not on it yet? Do step 1 first.
            </span>
          </p>
        </section>
      </template>

      <!-- Paired devices -->
      <section :aria-labelledby="ids.devices">
        <SectionHeading :id="ids.devices" as="h3" title="Paired devices" :count="server.devices.length || null" />
        <p v-if="!server.devices.length" class="mt-1 text-[0.95rem] text-muted-light">No paired devices yet.</p>
        <ul v-else class="mt-1 flex flex-col divide-y divide-line-dark/70">
          <li v-for="device in server.devices" :key="device.id" data-slot="live-device" class="flex items-center gap-3 py-2">
            <Smartphone class="size-5 shrink-0 text-gold" :stroke-width="1.5" aria-hidden="true" />
            <div class="min-w-0 flex-1 leading-snug">
              <p class="truncate font-medium">{{ device.name }}</p>
              <p class="text-sm text-muted-light">
                Paired {{ formatDateTime(device.pairedAt) }}<template v-if="device.lastSeenAt">, last seen <RelativeTime :value="device.lastSeenAt" /></template>
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              class="text-[#e08a6c] hover:text-[#f0a488]"
              :disabled="server.revoking === device.id"
              :aria-label="`Unpair ${device.name}`"
              @click="toRevoke = device"
            >
              <LoaderCircle v-if="server.revoking === device.id" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Unpair
            </Button>
          </li>
        </ul>
        <p v-if="server.deviceError" role="alert" :class="[noticeClass, 'mt-2 border-ember/50 bg-ember/10']">
          <TriangleAlert class="mt-0.5 size-4 shrink-0 text-[#e08a6c]" aria-hidden="true" />
          <span>Couldn't unpair: {{ server.deviceError }}</span>
        </p>
      </section>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    v-model:open="confirmOpen"
    :title="`Unpair ${toRevoke?.name ?? 'this device'}?`"
    description="This device won't be able to open or update Ash Log anymore. You can always pair it again."
    confirm-label="Unpair"
    @confirm="revoke"
  />
</template>
