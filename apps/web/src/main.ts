import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@fontsource/instrument-sans/400.css'
import '@fontsource/instrument-sans/500.css'
import '@fontsource/instrument-sans/600.css'
import '@fontsource/bricolage-grotesque/700.css'
import '@fontsource/jetbrains-mono/400.css'
import './assets/main.css'

import App from './App.vue'
import router from './router'
import { config } from './config'
import { isDesktop, onDeepLinks } from './platform/desktop'
import { followReducedTransparency, vibrant } from './platform/vibrancy'
import { startNotificationClicks } from './platform/notifier'
import { onPushClick } from './platform/webPush'
import { desktopLinkRoute } from './platform/signInLinks'
import { useAuthStore } from './stores/auth'
import { useComposeStore } from './stores/compose'

if (vibrant) {
  document.documentElement.classList.add('vibrant')
  followReducedTransparency()
}

const app = createApp(App)

app.use(createPinia())
// The desktop app reads the previous sign-in from the keychain before the first screen, so it never flashes the
// sign-in screen. Before the router: installing it starts the first navigation, whose guard must see the sign-in, or
// a reload on a signed-in screen lands on the inbox.
const auth = useAuthStore()
await auth.restore()
app.use(router)

// The desktop app takes sign-in results from the system browser as `tresso://` links.
if (isDesktop) {
  await onDeepLinks((link) => {
    const route = desktopLinkRoute(link, config.redirectUri, auth.hasPendingSignIn())
    if (route !== null) {
      void router.replace(route)
    }
  })
  // A click on a mail notification opens its conversation.
  startNotificationClicks(
    (path) => void router.push(path),
    (error) => useComposeStore().notify({ text: `Clicking a notification will not open it: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' }),
  )
} else {
  // A click on a browser notification while Tresso is open opens it here.
  onPushClick((path) => void router.push(path))
}

app.mount('#app')
