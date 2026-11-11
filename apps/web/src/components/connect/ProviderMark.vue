<script setup lang="ts">
import { PROVIDERS, type ProviderChoice } from './providers'

/** A provider's round mark: its letter on its own color. */
defineProps<{ provider: ProviderChoice; size?: number }>()
</script>

<template>
  <span class="provider-mark" :class="provider" :style="{ width: `${size ?? 40}px`, height: `${size ?? 40}px`, fontSize: `${Math.round((size ?? 40) * 0.42)}px` }" aria-hidden="true">{{
    PROVIDERS[provider].mark
  }}</span>
</template>

<style scoped>
.provider-mark {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--mark-bg);
  color: var(--mark-fg);
  font-family: var(--font-display);
  font-weight: 700;
  line-height: 1;
}
.google {
  --mark-bg: #e8f0fe;
  --mark-fg: #1a56c4;
}
.outlook {
  --mark-bg: #e3f0fb;
  --mark-fg: #0b5cab;
}
.m365 {
  --mark-bg: #eeeafb;
  --mark-fg: #5b45b8;
}
.icloud {
  --mark-bg: #eef0f3;
  --mark-fg: #2c3038;
}
.yahoo {
  --mark-bg: #f1eafb;
  --mark-fg: #5f2eb3;
}
.exchange {
  --mark-bg: #e6f4f1;
  --mark-fg: #256b5d;
}
.manual {
  --mark-bg: #f3f4f6;
  --mark-fg: #4a505c;
}
@media (prefers-color-scheme: dark) {
  .google {
    --mark-bg: rgb(26 86 196 / 28%);
    --mark-fg: #a9c4ff;
  }
  .outlook {
    --mark-bg: rgb(11 92 171 / 30%);
    --mark-fg: #9fcaf2;
  }
  .m365 {
    --mark-bg: rgb(91 69 184 / 30%);
    --mark-fg: #c4b7f5;
  }
  .icloud {
    --mark-bg: rgb(255 255 255 / 10%);
    --mark-fg: #dfe2e8;
  }
  .yahoo {
    --mark-bg: rgb(95 46 179 / 30%);
    --mark-fg: #cdb1f5;
  }
  .exchange {
    --mark-bg: rgb(37 107 93 / 30%);
    --mark-fg: #8fd6c4;
  }
  .manual {
    --mark-bg: rgb(255 255 255 / 8%);
    --mark-fg: var(--ink-2);
  }
}
</style>
