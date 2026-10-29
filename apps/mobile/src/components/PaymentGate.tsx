import { useEffect } from 'react'
import { router } from 'expo-router'
import { useAuth } from '@/auth/AuthProvider'
import { PaymentRequired } from '@/components/PaymentRequired'

/**
 * Shows {@link PaymentRequired} over everything while the signed-in user's server answers 402. Open modal screens
 * (writing, handing over) close first: on iOS they would sit above the notice.
 */
export function PaymentGate() {
  const auth = useAuth()
  const blocked = auth.isAuthenticated && auth.paymentRequired

  useEffect(() => {
    if (blocked && router.canDismiss()) {
      router.dismissAll()
    }
  }, [blocked])

  return blocked ? <PaymentRequired /> : null
}
