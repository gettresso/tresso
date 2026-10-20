<script setup lang="ts">
/** Icons from the foundations board: 24 px grid, 2 px stroke, round caps, outline only. */
const paths = {
  inbox: ['M3 13l3-8h12l3 8v6H3z', 'M3 13h5l1 3h6l1-3h5'],
  attachment: ['M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
  blocked: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9.5 9.5l5 5', 'M14.5 9.5l-5 5'],
  shieldAlert: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M12 8v5', 'M12 16h.01'],
  scanning: ['M21 12a9 9 0 11-3-6.7', 'M21 4v5h-5'],
  image: ['M4 5h16v14H4z', 'M4 15l4-4 5 5', 'M13 13l2-2 5 5'],
  flag: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  back: ['M15 18l-6-6 6-6'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  outbox: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z'],
  draft: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  reply: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 016 6v4'],
  replyAll: ['M7 14L2 9l5-5', 'M12 14L7 9l5-5', 'M7 9h7a6 6 0 016 6v4'],
  forward: ['M15 14l5-5-5-5', 'M20 9H10a6 6 0 00-6 6v4'],
  search: ['M11 4a7 7 0 100 14 7 7 0 000-14z', 'M20 20l-3.5-3.5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  archive: ['M3 4h18v4H3z', 'M5 8v12h14V8', 'M10 12h4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  unread: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
  folder: ['M3 6h6l2 2h10v11H3z'],
  do: ['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M8 12.5l2.5 2.5L16 9.5'],
  delegate: ['M9 4.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z', 'M3 20c0-3.3 2.7-6 6-6', 'M14 16h7', 'M18 13l3 3-3 3'],
  know: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 100 6 3 3 0 000-6z'],
  none: ['M6 12h12'],
  chevron: ['M6 9l6 6 6-6'],
  todo: ['M6 4h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2z', 'M8 12l3 3 5-6'],
  clock: ['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M12 7v5l3 2'],
  mail: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
  calendar: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v5', 'M16 3v5'],
  video: ['M3 7h12v10H3z', 'M15 10l6-3v10l-6-3'],
  place: ['M12 21s7-6.2 7-11.5a7 7 0 10-14 0C5 14.8 12 21 12 21z', 'M12 7a2.5 2.5 0 100 5 2.5 2.5 0 000-5z'],
  people: ['M9 4.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z', 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6', 'M16 5a3 3 0 010 6', 'M18 14c2 .6 3 2.8 3 6'],
  repeat: ['M17 2l4 4-4 4', 'M3 11V9a3 3 0 013-3h15', 'M7 22l-4-4 4-4', 'M21 13v2a3 3 0 01-3 3H3'],
  bell: ['M6 9a6 6 0 1112 0c0 6 3 7 3 7H3s3-1 3-7', 'M10 20a2 2 0 004 0'],
  plus: ['M12 5v14', 'M5 12h14'],
  next: ['M9 6l6 6-6 6'],
  triage: ['M4 6h16', 'M4 12h9', 'M4 18h9', 'M15 15l2.5 2.5L21 13'],
  settings: ['M4 6h9', 'M17 6h3', 'M13 4v4', 'M4 12h3', 'M11 12h9', 'M7 10v4', 'M4 18h11', 'M19 18h1', 'M15 16v4'],
} as const

defineProps<{ name: keyof typeof paths; size?: number; label?: string }>()
</script>

<template>
  <svg
    :width="size ?? 18"
    :height="size ?? 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <path v-for="d in paths[name]" :key="d" :d="d" />
  </svg>
</template>
