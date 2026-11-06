/**
 * Site-wide settings that are not copy. Copy lives in src/i18n.
 */
export const site = {
  name: 'tresso',
  url: 'https://gettresso.com',
  /**
   * Public repository of the open source edition. Leave null until the repository exists:
   * pages then say the repository opens at launch instead of linking to a dead URL.
   */
  repoUrl: 'https://github.com/gettresso/tresso' as string | null,
  /** Contact address shown in the footer. */
  contactEmail: 'hello@gettresso.com',
} as const;
