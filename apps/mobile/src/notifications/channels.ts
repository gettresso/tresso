import { AndroidImportance, setNotificationChannelAsync } from 'expo-notifications'

/**
 * The Android channels the API names in its pushes (PushMessage.php): `reminders` for calendar notifications, `mail`
 * for new mail that needs the user and `whatsapp` for new WhatsApp messages (only with the account's Notify me on),
 * each with a `_silent` twin for deliveries in quiet hours or focus. A push
 * naming a channel the phone does not have is shown in Android's fallback channel, so all of them exist before any push
 * arrives. iOS has no channels.
 */
export async function createNotificationChannels(platform: string): Promise<void> {
  if (platform !== 'android') {
    return
  }
  // High: a reminder shows as a banner on top of what the user is doing, with sound.
  await setNotificationChannelAsync('reminders', {
    name: 'Reminders',
    importance: AndroidImportance.HIGH,
    sound: 'default',
  })
  await setNotificationChannelAsync('reminders_silent', {
    name: 'Quiet reminders',
    description: 'Reminders that come during quiet hours or focus: in the list, without sound.',
    importance: AndroidImportance.LOW,
    sound: null,
    enableVibrate: false,
  })
  // Mail that needs the user (judged Do or Hand over) comes as a banner with sound, like a reminder.
  await setNotificationChannelAsync('mail', {
    name: 'New mail that needs you',
    description: 'New mail judged Do or Hand over. Other mail never notifies.',
    importance: AndroidImportance.HIGH,
    sound: 'default',
  })
  await setNotificationChannelAsync('mail_silent', {
    name: 'Quiet mail',
    description: 'New mail that needs you, during quiet hours or while you are busy: in the list, without sound.',
    importance: AndroidImportance.LOW,
    sound: null,
    enableVibrate: false,
  })
  // A new WhatsApp message names only its chat, never the text.
  await setNotificationChannelAsync('whatsapp', {
    name: 'WhatsApp',
    description: 'New WhatsApp messages, when Notify me is on for WhatsApp. Shows the chat, never the message.',
    importance: AndroidImportance.HIGH,
    sound: 'default',
  })
  await setNotificationChannelAsync('whatsapp_silent', {
    name: 'Quiet WhatsApp',
    description: 'New WhatsApp messages during quiet hours or while you are busy: in the list, without sound.',
    importance: AndroidImportance.LOW,
    sound: null,
    enableVibrate: false,
  })
}
