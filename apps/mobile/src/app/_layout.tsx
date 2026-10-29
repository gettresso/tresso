import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as WebBrowser from 'expo-web-browser'
import { AuthProvider } from '@/auth/AuthProvider'
import { MailProvider } from '@/mail/MailProvider'
import { NoticeProvider } from '@/components/Notices'
import { ComposerProvider } from '@/compose/ComposerProvider'
import { DeviceSetup } from '@/notifications/DeviceSetup'
import { HandOverProvider } from '@/handOver/HandOverProvider'
import { PaymentGate } from '@/components/PaymentGate'

// Closes the sign-in popup when the app runs on the web; a no-op on iOS and Android.
WebBrowser.maybeCompleteAuthSession()

export default function RootLayout() {
  return (
    <AuthProvider>
      <MailProvider>
        <NoticeProvider>
          <DeviceSetup />
          <ComposerProvider>
            <HandOverProvider>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="compose" options={{ presentation: 'modal' }} />
                <Stack.Screen name="hand-over" options={{ presentation: 'modal' }} />
              </Stack>
              <PaymentGate />
              <StatusBar style="auto" />
            </HandOverProvider>
          </ComposerProvider>
        </NoticeProvider>
      </MailProvider>
    </AuthProvider>
  )
}
