<script setup lang="ts">
import { computed, ref } from 'vue'
import { fileSize, type MessageAttachment, type ScanFailure } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { isDesktop, openInBrowser } from '@/platform/desktop'
import { useMailStore } from '@/stores/mail'
import AppIcon from '@/components/AppIcon.vue'
import LogoLoader from '@/components/LogoLoader.vue'

const props = defineProps<{
  attachments: MessageAttachment[]
  /**
   * The download links are signed and expire. Returns null while they are still good, else the attachments again
   * with fresh links (or throws when they could not be had).
   */
  renewLinks?: () => Promise<MessageAttachment[]> | null
}>()
const mail = useMailStore()
const failed = ref<string | null>(null)

const blocked = computed(() => props.attachments.filter((attachment) => attachment.scanStatus === 'infected'))
const others = computed(() => props.attachments.filter((attachment) => attachment.scanStatus !== 'infected'))

/** Files that could not be scanned download only after the reader confirms, once per file. */
const confirming = ref<string | null>(null)

const failureText: Record<ScanFailure, string> = {
  too_large: 'too large to scan',
  unscannable: 'the scanner could not read it',
  unavailable: 'the scanner was not available',
  disabled: 'scanning is turned off',
}

/**
 * Downloads a file that could not be scanned, after the reader confirmed: the link is asked for only now. The tab
 * opens in the click, so the browser does not block it; the link follows. The desktop app has no tabs and must not
 * leave its own page: the file opens in the user's browser.
 */
async function downloadAnyway(attachment: MessageAttachment): Promise<void> {
  confirming.value = null
  failed.value = null
  const opened = isDesktop ? null : window.open('about:blank', '_blank')
  if (opened !== null) {
    opened.opener = null
  }
  try {
    const url = await mail.unscannedLink(attachment.id)
    if (isDesktop) {
      await openInBrowser(url)
    } else if (opened === null) {
      window.location.assign(url)
    } else {
      opened.location.href = url
    }
  } catch (error) {
    opened?.close()
    failed.value = `${attachment.filename} could not be downloaded: ${errorMessage(error)}`
  }
}

/**
 * Opens a file through its link, or, once the links may have expired, through a fresh one. The tab opens in the click,
 * so the browser does not block it; the fresh link follows.
 */
async function download(event: MouseEvent, attachment: MessageAttachment): Promise<void> {
  const renewing = props.renewLinks?.() ?? null
  if (renewing === null) {
    return
  }
  event.preventDefault()
  failed.value = null
  const opened = window.open('about:blank', '_blank')
  if (opened !== null) {
    opened.opener = null
  }
  try {
    const fresh = (await renewing).find((other) => other.id === attachment.id)
    if (fresh === undefined || fresh.access !== 'allowed' || fresh.url === null) {
      opened?.close()
      failed.value = `${attachment.filename} can no longer be downloaded from here.`
      return
    }
    if (opened === null) {
      window.location.assign(fresh.url)
      return
    }
    opened.location.href = fresh.url
  } catch (error) {
    opened?.close()
    failed.value = `${attachment.filename} could not be downloaded: ${errorMessage(error)}`
  }
}

function notScanned(attachment: MessageAttachment): string {
  return `not scanned, ${attachment.scanFailure === null ? 'the scan failed' : failureText[attachment.scanFailure]}`
}
</script>

<template>
  <section v-if="attachments.length > 0" class="attachments" aria-label="Attachments">
    <h2 class="heading">{{ attachments.length === 1 ? '1 attachment' : `${attachments.length} attachments` }}</h2>

    <div v-for="attachment in blocked" :key="attachment.id" class="blocked" role="group" :aria-label="`${attachment.filename}, blocked`">
      <div class="blocked-main">
        <span class="icon icon-large icon-danger"><AppIcon name="shieldAlert" :size="20" /></span>
        <span class="text">
          <span class="name">{{ attachment.filename }}</span>
          <span class="blocked-detail">
            Blocked: malware found.
            <span v-if="attachment.scanSignature" class="signature">{{ attachment.scanSignature }}</span>
          </span>
        </span>
        <span class="pill">Quarantined</span>
        <button type="button" class="unavailable" disabled>Download unavailable</button>
      </div>
      <p class="blocked-note">{{ fileSize(attachment.size) }}. The file stays in quarantine and never reaches your device.</p>
    </div>

    <ul v-if="others.length > 0" class="files">
      <li v-for="attachment in others" :key="attachment.id" class="file">
        <span v-if="attachment.scanStatus === 'clean'" class="icon icon-clean"><AppIcon name="shield" /></span>
        <span v-else-if="attachment.scanStatus === 'pending'" class="icon"><LogoLoader /></span>
        <span v-else class="icon"><AppIcon name="shieldAlert" /></span>

        <span class="text">
          <span class="name">{{ attachment.filename }}</span>
          <span v-if="attachment.scanStatus === 'clean'" class="detail">{{ fileSize(attachment.size) }}, scanned, no threats found</span>
          <template v-else-if="attachment.scanStatus === 'pending'">
            <span class="detail">{{ fileSize(attachment.size) }}, scanning…</span>
            <span role="progressbar" class="progress" :aria-label="`Scanning ${attachment.filename}`"><span class="progress-bar" /></span>
          </template>
          <span v-else class="detail">{{ fileSize(attachment.size) }}, {{ notScanned(attachment) }}</span>
          <span v-if="confirming === attachment.id" class="confirm">
            Not checked for malware. Open only if you trust the sender.
            <button type="button" class="confirm-link" @click="downloadAnyway(attachment)">Download anyway</button>
          </span>
        </span>

        <a
          v-if="attachment.access === 'allowed' && attachment.url"
          :href="attachment.url"
          class="download"
          target="_blank"
          rel="noopener noreferrer"
          :aria-label="`Download ${attachment.filename}`"
          @click="download($event, attachment)"
          ><AppIcon name="download" :size="16"
        /></a>
        <button
          v-else-if="attachment.access === 'confirm'"
          type="button"
          class="download"
          :aria-expanded="confirming === attachment.id"
          :aria-label="`Download ${attachment.filename}, not scanned`"
          @click="confirming = confirming === attachment.id ? null : attachment.id"
        >
          <AppIcon name="download" :size="16" />
        </button>
        <button
          v-else
          type="button"
          class="download"
          disabled
          :aria-label="attachment.access === 'scanning' ? 'Download available after scan' : 'Download unavailable: not scanned'"
        >
          <AppIcon name="download" :size="16" />
        </button>
      </li>
    </ul>
    <p v-if="failed" class="failed" role="alert">{{ failed }}</p>
  </section>
</template>

<style scoped>
.attachments {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.heading {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.files {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.file {
  display: flex;
  flex: 1 1 260px;
  align-items: center;
  gap: 12px;
  max-width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
}
.icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-control);
  background: var(--ground);
  color: var(--ink-2);
  flex-shrink: 0;
}
.icon-large {
  width: 40px;
  height: 40px;
}
.icon-clean {
  background: var(--know-soft);
  color: var(--know);
}
.icon-danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.text {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 2px;
  min-width: 0;
}
.name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.detail {
  font-size: 12px;
  color: var(--ink-2);
}
.progress {
  display: block;
  height: 4px;
  margin-top: 2px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}
.progress-bar {
  display: block;
  width: 40%;
  height: 100%;
  border-radius: 999px;
  background: var(--ink-2);
  animation: scanning 1.4s ease-in-out infinite;
}
@keyframes scanning {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .progress-bar {
    width: 100%;
    animation: none;
    opacity: 0.5;
  }
}
.confirm {
  font-size: 12px;
  color: var(--ink);
}
.confirm-link {
  margin-left: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--focus);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.failed {
  margin: 0;
  font-size: 13px;
  color: var(--danger);
}
.download {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink);
  flex-shrink: 0;
  cursor: pointer;
}
.download:disabled {
  border-color: var(--line);
  background: var(--ground);
  color: var(--ink-3);
  cursor: not-allowed;
}
.blocked {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: 1.5px solid var(--danger);
  border-radius: var(--radius-card);
}
.blocked-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.blocked-main .text {
  min-width: 200px;
}
.blocked-detail {
  font-size: 13px;
  color: var(--danger);
}
.signature {
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.pill {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
  font-weight: 600;
}
.unavailable {
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--ground);
  color: var(--ink-3);
  font: 600 13px var(--font-ui);
  cursor: not-allowed;
}
.blocked-note {
  margin: 0;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font-size: 13px;
  color: var(--ink-2);
}
</style>
