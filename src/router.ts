import { createRouter, createWebHistory } from 'vue-router'

// The route names of the three views are the view names of src/stores/viewMemory.ts (VIEW_NAMES,
// with their base paths in VIEW_PATHS): the views stay alive and are told apart by route name.
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/quests' },
    { path: '/quests/:questId?', name: 'quests', component: () => import('./views/QuestsView.vue') },
    { path: '/kaart', name: 'map', component: () => import('./views/MapView.vue') },
    { path: '/verzamelingen', name: 'collections', component: () => import('./views/CollectionsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/quests' },
  ],
})
