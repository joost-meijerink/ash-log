import '@fontsource/cinzel/500.css'
import '@fontsource/cinzel/700.css'
import '@fontsource/alegreya-sans/400.css'
import '@fontsource/alegreya-sans/500.css'
import '@fontsource/alegreya-sans/700.css'
import '@fontsource/alegreya/400-italic.css'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import './style.css'

import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { useViewMemoryStore } from './stores/viewMemory'
import { registerServiceWorker, stripDeviceToken } from './sw-register'

// The app puts every scroll position back itself (src/stores/viewMemory.ts). Left on 'auto', the
// browser scrolls on back and forward as well: to the #anchor of an address it comes back to, and
// moves the focus there, right after the view was put back where it was left.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

const pinia = createPinia()
const app = createApp(App).use(pinia)
// Before the router starts its first navigation: the view memory follows every route change
// ahead of anything else that reacts to it.
useViewMemoryStore(pinia).attach(router)
app.use(router).mount('#app')

// The iPhone app opens without the Mac too (production build, https, phones only).
void registerServiceWorker({ router })
void stripDeviceToken(router).catch(() => undefined)
