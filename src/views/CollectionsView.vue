<script setup lang="ts">
import { computed } from 'vue'
import { Package, Sparkles, Vault as VaultIcon } from 'lucide-vue-next'
import { EmptyState, ParchmentPanel, SectionHeading } from '@/components/common'
import ChestMatrix from '@/components/collections/ChestMatrix.vue'
import CollectionsNav from '@/components/collections/CollectionsNav.vue'
import CollectionsSummary from '@/components/collections/CollectionsSummary.vue'
import RewardBrowser from '@/components/collections/RewardBrowser.vue'
import VaultCard from '@/components/collections/VaultCard.vue'
import { useCollectionAnchor } from '@/composables/useCollectionAnchor'
import { useCollections } from '@/composables/useCollections'
import { provideViewRoute } from '@/composables/useViewRoute'
import { tallyText } from '@/lib/collections-shared'
import { useProgressStore } from '@/stores/progress'

// First: the view stays alive while another one is on screen, and everything below reads the
// route of this view (useViewRoute), never that of the view that is on screen instead.
provideViewRoute('collections')

const progress = useProgressStore()
const { owned, vaultCards, haystacks, regions, summary } = useCollections()
const { highlighted } = useCollectionAnchor({ highlight: (id) => id.startsWith('vault-') })

/** Toggles wait until progress.json is loaded, so nothing gets lost, and while the Mac cannot be reached. */
const locked = computed(() => !progress.canEdit)

const sections = computed(() => [
  { id: 'vaults', label: 'Dragonkin Vaults', short: 'Vaults', icon: VaultIcon, count: tallyText(summary.value.vaults) },
  { id: 'unlocks', label: 'Unique unlocks', short: 'Unlocks', icon: Sparkles, count: tallyText(summary.value.rewards) },
  { id: 'chests', label: 'Treasure chests', short: 'Chests', icon: Package },
])
</script>

<template>
  <div class="relative pb-16">
    <div class="mx-auto w-full max-w-6xl px-4 pt-6 pb-5 sm:px-6 sm:pt-8">
      <h1 class="font-display text-2xl font-semibold tracking-[0.08em] text-text-light uppercase sm:text-[1.7rem]">
        Collections
      </h1>
      <p class="mt-1.5 max-w-prose text-muted-light">
        Tick off what you unlock once. The chests are here too, so you can find them again.
      </p>
      <CollectionsSummary :summary="summary" class="mt-5" />
    </div>

    <CollectionsNav :items="sections" />

    <div class="mx-auto flex w-full max-w-6xl flex-col gap-12 px-4 pt-7 sm:px-6">
      <!-- Dragonkin Vaults -->
      <section id="vaults" tabindex="-1" class="scroll-mt-16 outline-none" aria-labelledby="vaults-title">
        <SectionHeading :count="tallyText(summary.vaults)">
          <span id="vaults-title">Dragonkin Vaults</span>
        </SectionHeading>
        <p class="mt-1 mb-4 text-sm text-muted-light">In the wiki's standard progression order.</p>

        <div v-if="vaultCards.length" class="grid items-stretch gap-4 lg:grid-cols-2">
          <VaultCard
            v-for="card in vaultCards"
            :key="card.vault.id"
            :card="card"
            :owned="owned"
            :highlighted="highlighted === card.anchor"
            :disabled="locked"
          />
        </div>
        <ParchmentPanel v-else>
          <EmptyState
            compact
            :icon="VaultIcon"
            title="No vaults yet"
            text="The vaults come from the Dragonkin Vault wiki page. Run a sync to fetch them."
          />
        </ParchmentPanel>
      </section>

      <!-- Unique unlocks -->
      <section id="unlocks" tabindex="-1" class="scroll-mt-16 outline-none" aria-labelledby="unlocks-title">
        <SectionHeading :count="tallyText(summary.rewards)" class="mb-4">
          <span id="unlocks-title">Unique unlocks</span>
        </SectionHeading>
        <RewardBrowser :owned="owned" :haystacks="haystacks" :regions="regions" :disabled="locked" />
      </section>

      <!-- Treasure chests -->
      <section id="chests" tabindex="-1" class="scroll-mt-16 outline-none" aria-labelledby="chests-title">
        <SectionHeading class="mb-4">
          <span id="chests-title">Treasure chests</span>
        </SectionHeading>
        <ChestMatrix />
      </section>
    </div>
  </div>
</template>
