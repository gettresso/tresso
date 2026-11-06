/**
 * Site-wide settings that are not copy. Copy lives in src/i18n.
 */
export const site = {
  name: 'tresso',
  url: 'https://gettresso.com',
  /**
   * The public repository. Pages link to it, its releases and its self-host files; null would make them say the
   * repository opens at launch instead.
   */
  repoUrl: 'https://github.com/gettresso/tresso' as string | null,
  /** The desktop install commands, as the repository's README gives them. */
  installScripts: {
    unix: 'curl -fsSL https://sherin.dev/tresso/install.sh | bash',
    windows: 'powershell -c "irm https://sherin.dev/tresso/install.ps1|iex"',
  },
  /** Contact address shown in the footer. */
  contactEmail: 'hello@gettresso.com',
} as const;
