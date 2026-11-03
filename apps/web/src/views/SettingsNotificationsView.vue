<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import type { NotificationChannel, NotificationSettings } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { mailNotificationPatch, mailNotificationSchema, mailNotificationValues, type MailNotificationValues } from '@/forms/notifications'
import { isDesktop } from '@/platform/desktop'
import { currentSubscription, disableWebPush, enableWebPush, webPushSupported } from '@/platform/webPush'
import { useAuthStore } from '@/stores/auth'
import LogoLoader from '@/components/LogoLoader.vue'

const CHANNELS: { value: NotificationChannel; label: string; hint: string }[] = [
  { value: 'phone', label: 'Phone', hint: 'The Tresso app on your phone' },
  { value: 'desktop', label: isDesktop ? 'This computer and browsers' : 'Desktop app and browsers', hint: 'Browsers where notifications are on' },
  { value: 'email', label: 'Email', hint: 'A message to your notification address' },
]

const auth = useAuthStore()

const loading = ref(true)
const saving = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)

const { defineField, handleSubmit, values, resetForm, setErrors, setFieldValue } = useForm<MailNotificationValues>({
  validationSchema: toTypedSchema(mailNotificationSchema),
  initialValues: { channels: [], holdInMeetings: true, previews: true },
})
const [holdInMeetings] = defineField('holdInMeetings')
const [previews] = defineField('previews')
const channels = computed(() => values.channels ?? [])

function toggle(channel: NotificationChannel): void {
  setFieldValue('channels', channels.value.includes(channel) ? channels.value.filter((c) => c !== channel) : [...channels.value, channel])
}

const save = handleSubmit(async (current) => {
  saving.value = true
  error.value = null
  message.value = null
  try {
    const saved = await auth.send<NotificationSettings>('PATCH', '/api/v1/notification-settings', mailNotificationPatch(current))
    resetForm({ values: mailNotificationValues(saved) })
    message.value = current.channels.length === 0 ? 'Saved. New mail no longer notifies you.' : 'Saved.'
  } catch (e) {
    error.value = errorMessage(e)
    if (e instanceof ApiError) setErrors(e.violations)
  } finally {
    saving.value = false
  }
})

/** Web Push in this browser; the desktop app shows its notifications natively instead. */
const browser = webPushSupported()
const browserOn = ref(false)
const browserBusy = ref(false)
const browserError = ref<string | null>(null)

async function switchBrowser(on: boolean): Promise<void> {
  browserBusy.value = true
  browserError.value = null
  try {
    if (on) {
      const userId = auth.me?.id
      if (userId === undefined) {
        throw new Error('Your account is still loading. Try again in a moment.')
      }
      await enableWebPush((path) => auth.api(path), (method, path, body) => auth.send(method, path, body), userId)
    } else {
      await disableWebPush((method, path, body) => auth.send(method, path, body))
    }
    browserOn.value = (await currentSubscription()) !== null
  } catch (e) {
    browserError.value = errorMessage(e)
  } finally {
    browserBusy.value = false
  }
}

onMounted(async () => {
  try {
    resetForm({ values: mailNotificationValues(await auth.api<NotificationSettings>('/api/v1/notification-settings')) })
    browserOn.value = browser && Notification.permission === 'granted' && (await currentSubscription()) !== null
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <section class="notifications">
    <header>
      <h2>Notifications</h2>
      <p>Only new mail that needs you, judged Do or Hand over, unread in an inbox. Everything else waits until you look.</p>
    </header>
    <p v-if="loading" class="state" role="status"><LogoLoader /> Loading your settings…</p>
    <form v-else class="mail" aria-label="Mail notifications" novalidate @submit.prevent="save">
      <fieldset class="channels">
        <legend>Notify me of new mail on</legend>
        <label v-for="channel in CHANNELS" :key="channel.value" class="check">
          <input type="checkbox" :checked="channels.includes(channel.value)" @change="toggle(channel.value)" />
          <span>{{ channel.label }}</span>
          <span class="hint">{{ channel.hint }}</span>
        </label>
      </fieldset>
      <label class="check">
        <input v-model="holdInMeetings" type="checkbox" />
        <span>Hold mail notifications while I am in a meeting</span>
      </label>
      <p class="hint">Focus blocks hold them too, and during quiet hours they come without sound.</p>
      <label class="check">
        <input v-model="previews" type="checkbox" />
        <span>Show message content in notifications</span>
      </label>
      <p class="hint">
        The sender, subject and the start of the text. Without, a notification only says which account has new mail. Phone
        notifications pass through Expo, Apple and Google unencrypted; browser notifications are encrypted end to end.
      </p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-if="message" class="done" role="status">{{ message }}</p>
      <div class="actions">
        <button type="submit" class="button button-primary" :disabled="saving">Save</button>
      </div>
    </form>
    <section v-if="browser" class="browser" aria-label="This browser">
      <h3>This browser</h3>
      <p v-if="browserOn">Notifications for the desktop come to this browser, also while Tresso is closed.</p>
      <p v-else>Turn notifications on to get them in this browser, also while Tresso is closed.</p>
      <p class="hint">
        Using the Tresso desktop app on this computer? Leave this off: the app shows the same notifications, so you would
        get each one twice.
      </p>
      <p v-if="browserError" class="form-error" role="alert">{{ browserError }}</p>
      <button type="button" class="button" :disabled="browserBusy" @click="switchBrowser(!browserOn)">
        {{ browserOn ? 'Turn off in this browser' : 'Turn on in this browser' }}
      </button>
    </section>
  </section>
</template>

<style scoped>
.notifications {
  display: flex;
  flex-direction: column;
  gap: 24px;
  max-width: 640px;
}
h2 {
  margin: 0 0 4px;
  font: 700 22px/28px var(--font-display);
}
h3 {
  margin: 0;
  font-size: 15px;
}
header p,
.state,
.hint {
  margin: 0;
  color: var(--ink-2);
}
.mail,
.browser {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.channels {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  border: 0;
}
.channels legend {
  padding: 0 0 6px;
  font-weight: 600;
}
.check {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  font-size: 14px;
  cursor: pointer;
}
.check input {
  width: 18px;
  height: 18px;
  margin: 0;
  accent-color: var(--ink);
}
.check .hint {
  font-size: 13px;
}
.done {
  margin: 0;
  color: var(--know);
  font-weight: 500;
}
.form-error {
  margin: 0;
}
.actions {
  display: flex;
  gap: 8px;
}
</style>
