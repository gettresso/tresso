import { useAuth } from '@/auth/AuthProvider'
import { PaymentRequired } from '@/components/PaymentRequired'

/** Shows {@link PaymentRequired} over everything while the signed-in user's server answers 402. */
export function PaymentGate() {
  const auth = useAuth()

  return auth.isAuthenticated && auth.paymentRequired ? <PaymentRequired /> : null
}
