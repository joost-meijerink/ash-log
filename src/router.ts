import { createRouter, createWebHistory } from 'vue-router'
import { LEGACY_VIEW_PATHS, legacyRedirect } from './lib/legacy-url'

// The route names of the three views are the view names of src/stores/viewMemory.ts (VIEW_NAMES,
// with their base paths in VIEW_PATHS): the views stay alive and are told apart by route name.
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/quests' },
    { path: '/quests/:questId?', name: 'quests', component: () => import('./views/QuestsView.vue') },
    { path: '/map', name: 'map', component: () => import('./views/MapView.vue') },
    { path: '/collections', name: 'collections', component: () => import('./views/CollectionsView.vue') },
    // The Dutch paths of older bookmarks. A redirect keeps the query and the hash.
    ...Object.entries(LEGACY_VIEW_PATHS).map(([path, redirect]) => ({ path, redirect })),
    { path: '/:pathMatch(.*)*', redirect: '/quests' },
  ],
})

// Dutch query keys and values of older bookmarks (?soort=, ?status=bezig): rewritten before a
// view sees them, in the same history entry. See src/lib/legacy-url.ts.
router.beforeEach((to) => legacyRedirect(to) ?? true)
