/**
 * English copy. This is the source dictionary: every other locale must match its shape (see Dict).
 * Never use em or en dashes in copy. [PRICE] marks prices that are not decided yet.
 *
 * Keep statuses honest and in step with docs/ROADMAP.md: 'available' is released on main, 'next' is still to come in
 * a phase that is under way, 'planned' is on the roadmap but not started.
 */
export type Verdict = 'do' | 'handOver' | 'know';
export type Status = 'available' | 'next' | 'planned';
export type PlanTarget = 'openSource' | 'download';

export const en = {
  langName: 'English',
  meta: {
    description:
      'tresso is an open source email client and calendar for all your accounts, where every email is something to do, hand over or know. Free on your own server, or hosted for you as tresso Cloud.',
  },
  nav: {
    features: 'Features',
    pricing: 'Pricing',
    openSource: 'Open source',
    download: 'Download',
    menu: 'Menu',
    language: 'Language',
    skip: 'Skip to content',
    home: 'tresso home',
  },
  footer: {
    tagline: 'One T, three ways out.',
    product: 'Product',
    project: 'Project',
    releases: 'Releases',
    contact: 'Contact',
    license: 'Open source under AGPL-3.0.',
    madeIn: 'Made in the Netherlands.',
  },
  verdicts: {
    do: 'Do',
    handOver: 'Hand over',
    know: 'Know',
  },
  statuses: {
    available: 'Available',
    next: 'Coming next',
    planned: 'Planned',
  },
  repo: {
    link: 'View on GitHub',
    pending: 'The public repository opens at launch.',
  },
  home: {
    title: 'tresso: every email is something to do, hand over or know',
    status: 'Open source under AGPL-3.0',
    heroTitle: 'Every email is something to do, hand over or know.',
    heroLead:
      'tresso is an email client and calendar for all your accounts that turns reading into deciding. Each message leaves your inbox as a todo, a handover to someone else, or a line in your daily brief.',
    ctaPrimary: 'Download tresso',
    ctaSecondary: 'Run your own server',
    demo: {
      label: 'Example of a unified inbox with a verdict on every email',
      title: 'Unified Inbox',
      accounts: '3 accounts',
      keysHint: 'Settle each email with one key',
      unread: 'Unread',
      rows: [
        {
          from: 'Lena Hartmann',
          subject: 'Contract renewal: signature needed by Friday',
          verdict: 'do' as Verdict,
          note: 'Todo, due Fri',
          time: '09:12',
          unread: true,
        },
        {
          from: 'Support queue',
          subject: 'Customer cannot export last month’s invoices',
          verdict: 'handOver' as Verdict,
          note: 'To Sam, due Wed',
          time: '08:47',
          unread: true,
        },
        {
          from: 'Product Weekly',
          subject: 'What shipped this week',
          verdict: 'know' as Verdict,
          note: 'In your brief',
          time: '07:30',
          unread: false,
        },
        {
          from: 'Pieter de Vries',
          subject: 'Could you review the Q3 deck before Thursday?',
          verdict: 'do' as Verdict,
          note: 'Todo, due Thu',
          time: 'Yesterday',
          unread: false,
        },
        {
          from: 'Building management',
          subject: 'Elevator maintenance on Thursday morning',
          verdict: 'know' as Verdict,
          note: 'In your brief',
          time: 'Yesterday',
          unread: false,
        },
      ],
    },
    ways: {
      eyebrow: 'The idea',
      title: 'One T, three ways out.',
      lead: 'The tresso mark is a T made of three bars. Each bar is one way an email can leave your inbox. Nothing just sits there.',
      happens: 'What happens',
      doneWhen: 'Done when',
      items: {
        do: {
          happens: 'It becomes a todo, linked to the email, with a due date when there is one.',
          doneWhen: 'The todo is completed. The email archives itself.',
        },
        handOver: {
          happens: 'It goes to someone else with a note and a due date, and waits in Waiting on.',
          doneWhen: 'They finish it. Until then, tresso keeps track and nudges.',
        },
        know: {
          happens: 'It lands in your daily brief, together with everything else worth knowing.',
          doneWhen: 'You click Noted. One click, and the whole brief is handled.',
        },
      },
    },
    triage: {
      eyebrow: 'Triage mode',
      title: 'One email at a time. One key each.',
      lead: 'Triage mode shows a single conversation and waits for a decision. Press D, H or K and the next one appears. A busy morning inbox becomes a few minutes of choices.',
      keys: [
        { key: 'D', verdict: 'do' as Verdict },
        { key: 'H', verdict: 'handOver' as Verdict },
        { key: 'K', verdict: 'know' as Verdict },
      ],
    },
    progress: {
      eyebrow: 'Where it stands',
      title: 'Released, and growing in the open.',
      lead: 'tresso ships new releases often. This is what it does today, what comes next, and what is on the roadmap.',
      columns: [
        {
          status: 'available' as Status,
          items: [
            'Unified Inbox for IMAP, Gmail and Microsoft 365',
            'Do, hand over, know, with triage mode',
            'Todos, Waiting on and the daily brief',
            'Smart inboxes with rule-based classification',
            'Calendar with CalDAV, Google and Microsoft',
            'Push only for mail that needs you',
            'Virus scanning and encryption at rest per user',
            'Desktop apps with automatic updates',
            'An MCP endpoint for your settings',
          ],
        },
        {
          status: 'next' as Status,
          items: [
            'Calendar notification settings and push on every device',
            'Tomorrow at a glance and the week ahead',
            'Subjects and addresses encrypted too',
            'How busy a day is when you pick a due date',
          ],
        },
        {
          status: 'planned' as Status,
          items: [
            'AI with your own key or endpoint',
            'Teams with shared inboxes and delegation',
            'Webhooks and MCP tools for mail, todos and events',
            'Statistics and Year in mail',
          ],
        },
      ],
      more: 'Follow along on GitHub',
    },
    highlights: {
      eyebrow: 'Inside',
      title: 'Everything an email client should do, and a clear next step for every message.',
      more: 'All features',
      items: [
        {
          title: 'Unified Inbox',
          text: 'IMAP accounts, Gmail and Microsoft 365 in one inbox, sorted into smart inboxes: To do, Informational, Notifications, Newsletters, Invitations and Spam.',
        },
        {
          title: 'Built-in todos',
          text: 'Turn any email into a todo, or let a smart inbox do it for you. Give a todo a duration and plan it in your calendar.',
        },
        {
          title: 'Calendar included',
          text: 'CalDAV, Google and Microsoft calendars with online meetings, invitations answered from the email, and reminders on every device.',
        },
        {
          title: 'Search everything',
          text: 'Find any message across all your accounts, with filters for sender, folder, attachments and dates.',
        },
        {
          title: 'Safe by default',
          text: 'Attachments are scanned before they open, and your stored mail is encrypted per user.',
        },
        {
          title: 'Every device',
          text: 'Web, desktop and mobile apps. The desktop app keeps a local copy of your mail and updates itself.',
        },
      ],
    },
    editions: {
      eyebrow: 'Two ways to run it',
      title: 'Same code, every feature. You choose who runs it.',
      lead: 'tresso is fully open source. Run it on your own server for free, or let us host it for you. A subscription pays for hosting, never for features.',
      selfHosted: {
        name: 'Self-hosted',
        label: 'On your own server',
        text: 'The whole of tresso on a server you run, with Docker.',
        points: [
          'Every feature, free',
          'Production images for amd64 and arm64',
          'Automatic HTTPS and database migrations',
          'Your data on your own hardware',
          'AGPL-3.0',
        ],
        cta: 'Self-host tresso',
      },
      cloud: {
        name: 'tresso Cloud',
        label: 'Hosted by us',
        text: 'The same code and the same images, run for you with backups and support.',
        points: [
          'Every feature, nothing to run',
          '14-day free trial, no card needed',
          'One subscription per organization',
          'Backups, updates and support',
          'The default server in the desktop app',
        ],
        cta: 'See pricing',
      },
    },
    closing: {
      title: 'An inbox that empties on purpose.',
      lead: 'tresso runs on macOS, Windows and Linux today. The apps update themselves.',
      cta: 'Download tresso',
    },
  },
  features: {
    title: 'Features',
    eyebrow: 'Features',
    heroTitle: 'Built around one question: what does this email need from you?',
    heroLead:
      'Everything in tresso serves the three verdicts, and everything is open source: self-hosted servers get every feature. Each feature shows where it stands.',
    statusLegend: 'Status',
    groups: [
      {
        title: 'Inbox',
        items: [
          {
            title: 'Unified Inbox',
            text: 'IMAP and SMTP accounts, Gmail and Microsoft 365, together in one list with a reading pane.',
            status: 'available' as Status,
          },
          {
            title: 'Search',
            text: 'Search all your mail across every account, with from:, to:, in:, has:attachment and date filters.',
            status: 'available' as Status,
          },
          {
            title: 'Smart inboxes',
            text: 'To do, Informational, Notifications, Newsletters, Invitations and Spam, plus your own: a name, instructions and sender include and exclude lists, sorted by rules.',
            status: 'available' as Status,
          },
          {
            title: 'Triage mode',
            text: 'Undecided mail one conversation at a time, settled with D, H or K.',
            status: 'available' as Status,
          },
          {
            title: 'AI classification',
            text: 'Smart inboxes sorted by AI with your own key or endpoint, learning from every correction you make.',
            status: 'planned' as Status,
          },
        ],
      },
      {
        title: 'Write',
        items: [
          {
            title: 'Compose, reply and forward',
            text: 'Recipient suggestions, undo send and send later. Drafts sync across devices and are filed in your Drafts folder.',
            status: 'available' as Status,
          },
          {
            title: 'Signatures',
            text: 'An HTML signature per mail account, with a default for each, on every device.',
            status: 'available' as Status,
          },
          {
            title: 'Write on your phone',
            text: 'Compose on the phone too, with files attached.',
            status: 'available' as Status,
          },
        ],
      },
      {
        title: 'Do, hand over, know',
        items: [
          {
            title: 'Built-in todos',
            text: 'Make todo from any email, with a due date, synced across devices. Complete the todo and the email archives itself.',
            status: 'available' as Status,
          },
          {
            title: 'Todos made for you',
            text: 'Let any smart inbox turn its mail into todos automatically.',
            status: 'available' as Status,
          },
          {
            title: 'Todos in your calendar',
            text: 'Give a todo a duration and tresso finds the time for it in your calendar.',
            status: 'available' as Status,
          },
          {
            title: 'Hand over and Waiting on',
            text: 'Hand a conversation to someone with a note and a due date. tresso tracks it in Waiting on and nudges when it is late.',
            status: 'available' as Status,
          },
          {
            title: 'Daily brief',
            text: 'Everything worth knowing in one calm overview, once a day at your time. One click on Noted and it is done.',
            status: 'available' as Status,
          },
          {
            title: 'Busy hints',
            text: 'See how busy each day and hour already is when you pick a due date.',
            status: 'next' as Status,
          },
          {
            title: 'AI todos and summaries',
            text: 'Todos written from what an email asks of you, and the gist of each email in your brief, with your own AI key or endpoint.',
            status: 'planned' as Status,
          },
        ],
      },
      {
        title: 'Calendar',
        items: [
          {
            title: 'Your calendars',
            text: 'CalDAV, Google Calendar and Microsoft calendars, with recurring events and online meetings.',
            status: 'available' as Status,
          },
          {
            title: 'Invitations',
            text: 'Answer invitations right from the email, and add events an email proposes.',
            status: 'available' as Status,
          },
          {
            title: 'Calendar views',
            text: 'Day, week, month and agenda views, an event editor and a mini agenda next to your mail. Agenda and event details on the phone.',
            status: 'available' as Status,
          },
          {
            title: 'Find a time',
            text: 'Meeting times that fit, across time zones, with every suggestion explained.',
            status: 'available' as Status,
          },
          {
            title: 'Reminders',
            text: 'Several reminders per event, quiet hours, working hours and focus blocks.',
            status: 'available' as Status,
          },
          {
            title: 'Calendar notifications everywhere',
            text: 'Notification settings for the calendar, and calendar push on web, desktop and mobile.',
            status: 'next' as Status,
          },
          {
            title: 'Digests',
            text: 'Tomorrow at a glance at the end of your working day, and the week ahead.',
            status: 'next' as Status,
          },
        ],
      },
      {
        title: 'Quiet and tidy',
        items: [
          {
            title: 'Push for mail that needs you',
            text: 'Phone, desktop and browser notifications for mail to do or hand over, held during meetings and focus blocks.',
            status: 'available' as Status,
          },
          {
            title: 'Batched delivery',
            text: 'Newsletters and notifications arrive in batches, with one-click unsubscribe.',
            status: 'available' as Status,
          },
          {
            title: 'Bulk actions',
            text: 'Select many conversations and archive, move, flag or delete them at once.',
            status: 'available' as Status,
          },
          {
            title: 'Cleanup suggestions',
            text: 'Clear out mail by sender, smart inbox or age, with suggestions for what can go.',
            status: 'available' as Status,
          },
        ],
      },
      {
        title: 'Safe and private',
        items: [
          {
            title: 'Attachment virus scanning',
            text: 'Every attachment is scanned before it can be opened. Infected files go to quarantine.',
            status: 'available' as Status,
          },
          {
            title: 'Encryption at rest',
            text: 'Your stored mail, attachments and message texts encrypted with keys per user. Account passwords and tokens are encrypted too.',
            status: 'available' as Status,
          },
          {
            title: 'More encryption',
            text: 'Subjects, addresses and names sealed as well, and draft bodies, hand-over notes, event notes and todos.',
            status: 'next' as Status,
          },
        ],
      },
      {
        title: 'Every device',
        items: [
          {
            title: 'Desktop apps',
            text: 'macOS, Windows and Linux, with a local copy of your mail, native notifications and signed updates that install themselves.',
            status: 'available' as Status,
          },
          {
            title: 'Web',
            text: 'The same client in any modern browser.',
            status: 'available' as Status,
          },
          {
            title: 'Mobile app',
            text: 'Read, act on and write mail and see your agenda on the phone, with a local copy for speed.',
            status: 'available' as Status,
          },
        ],
      },
      {
        title: 'Connect',
        items: [
          {
            title: 'MCP endpoint',
            text: 'Let Claude and other MCP clients change your settings, signatures, smart inboxes and calendars, only with the permissions you allow.',
            status: 'available' as Status,
          },
          {
            title: 'Access tokens and connected apps',
            text: 'Personal access tokens with chosen scopes, and a list of the apps you allowed, to disconnect any time.',
            status: 'available' as Status,
          },
          {
            title: 'MCP tools for mail, todos and events',
            text: 'Let AI assistants work with your mail, todos and calendar, not only your settings.',
            status: 'planned' as Status,
          },
          {
            title: 'Webhooks and developer tools',
            text: 'Tell your own systems when something changes, and see what your integrations do.',
            status: 'planned' as Status,
          },
        ],
      },
      {
        title: 'Teams and insight',
        items: [
          {
            title: 'Organizations',
            text: 'Every account has its own organization, the base for teams and for subscriptions.',
            status: 'available' as Status,
          },
          {
            title: 'Teams',
            text: 'Shared inboxes, assignments, internal comments, delegation rules and workload.',
            status: 'planned' as Status,
          },
          {
            title: 'Statistics and Year in mail',
            text: 'How your mail flows, and once a year a personal look back at your year in email.',
            status: 'planned' as Status,
          },
        ],
      },
    ],
    closingTitle: 'Run it yourself, or let us host it.',
    closingCta: 'See pricing',
  },
  pricing: {
    title: 'Pricing',
    eyebrow: 'Pricing',
    heroTitle: 'Every feature, wherever it runs.',
    heroLead:
      'Self-hosting tresso is free. tresso Cloud is the same code, hosted for you: a subscription pays for running it, never for features.',
    free: 'Free',
    perMemberMonth: 'per member per month',
    plans: [
      {
        name: 'Self-hosted',
        price: 'free',
        text: 'tresso on your own server.',
        points: [
          'Every feature',
          'Web, desktop and mobile apps',
          'Production images and a compose file',
          'Your data on your own hardware',
          'Community support on GitHub',
        ],
        cta: 'Self-host tresso',
        target: 'openSource' as PlanTarget,
      },
      {
        name: 'tresso Cloud',
        price: '[PRICE]',
        text: 'tresso hosted for you, billed monthly or yearly.',
        points: [
          'Every feature',
          '14-day free trial, no card needed',
          'One subscription per organization, a seat per member',
          'Backups, updates and support',
          'Pay and manage it in the app',
        ],
        cta: 'Start your free trial',
        target: 'download' as PlanTarget,
      },
    ],
    note: 'Prices of tresso Cloud are not final yet. Taxes are calculated at checkout.',
    faqTitle: 'Questions',
    faq: [
      {
        q: 'Is self-hosted tresso limited?',
        a: 'No. Everything tresso does is in the open source repository, and a self-hosted server has every feature. A server bills only when billing is turned on, which it is not by default.',
      },
      {
        q: 'How does the trial work?',
        a: 'Every organization gets 14 days of tresso Cloud for free, without a card. Before the trial ends the app asks you to subscribe.',
      },
      {
        q: 'What happens when a subscription ends?',
        a: 'tresso Cloud stops syncing, sending and notifying for that organization. Your data stays as it is, and everything resumes once a subscription is active again.',
      },
      {
        q: 'Who pays?',
        a: 'A subscription belongs to an organization, and its members are its seats. One person with several mail accounts pays once.',
      },
      {
        q: 'Which mail providers work with tresso?',
        a: 'Any IMAP and SMTP account, plus Gmail and Microsoft 365 through their own sign-in. A self-hosted server needs an OAuth app at Google and Microsoft for those two.',
      },
      {
        q: 'Is my mail encrypted?',
        a: 'Yes. Stored mail and attachments are encrypted at rest with keys per user, and account passwords and tokens are encrypted too.',
      },
    ],
  },
  openSource: {
    title: 'Open source',
    eyebrow: 'Open source',
    heroTitle: 'Every feature, on your own server.',
    heroLead:
      'Everything tresso does is open source under AGPL-3.0: the apps, the server and the shared libraries. Running it yourself is free.',
    licenseTitle: 'One license, one repository',
    licenseName: 'AGPL-3.0',
    licenseText:
      'Use tresso, change it and host it. When you offer a changed version as a service, share your changes under the same license.',
    cloudTitle: 'And tresso Cloud?',
    cloudText:
      'tresso Cloud runs the same code and the same images. Billing lives in the repository too, turned on only on the server that bills. A subscription pays for hosting, backups and support, never for features.',
    includedTitle: 'What is in the repository',
    included: [
      'The API, the sync workers and the web client',
      'The desktop apps for macOS, Windows and Linux',
      'The mobile app',
      'Mail, search, smart inboxes and the three verdicts',
      'Todos, Waiting on and the daily brief',
      'Calendar, reminders and finding a time',
      'Virus scanning and encryption at rest',
      'Every feature still to come',
    ],
    quickstartTitle: 'Run it yourself',
    quickstartLead:
      'You need a server with Docker, two DNS names pointing at it (one for the web client, one for the API) and ports 80 and 443 open.',
    steps: [
      {
        title: 'Get the compose file',
        text: 'Download compose.prod.yaml and .env.prod.example from the repository into one folder.',
        code: '',
      },
      {
        title: 'Fill in your settings',
        text: 'Copy .env.prod.example to .env and fill in your two addresses and every secret. Keep a copy of DATA_KEYS somewhere safe: it encrypts your mail at rest.',
        code: 'openssl rand -hex 32',
      },
      {
        title: 'Start it',
        text: '',
        code: 'docker compose -f compose.prod.yaml --env-file .env up -d',
      },
      {
        title: 'Create your account',
        text: '',
        code: 'docker compose -f compose.prod.yaml exec api php bin/console app:user:create you@example.com "Your Name"',
      },
    ],
    quickstartNote:
      'The stack gets HTTPS certificates by itself, migrates the database on start and runs PostgreSQL, Redis, object storage, Meilisearch and ClamAV next to tresso. ClamAV needs about 1.5 GB of RAM. In the desktop app, choose Use another server and enter your API address. Full instructions, including Gmail and Microsoft 365, live in the repository.',
    stackTitle: 'Built with',
    stack: [
      { part: 'API', tech: 'PHP and Symfony on FrankenPHP' },
      { part: 'Sync workers', tech: 'Go' },
      { part: 'Web', tech: 'Vue and TypeScript' },
      { part: 'Desktop', tech: 'Tauri' },
      { part: 'Mobile', tech: 'Expo' },
      { part: 'Data', tech: 'PostgreSQL, Redis, S3 storage, Meilisearch' },
      { part: 'Scanning', tech: 'ClamAV' },
    ],
  },
  download: {
    title: 'Download',
    eyebrow: 'Download',
    heroTitle: 'tresso on every screen you use.',
    heroLead:
      'The desktop app signs in to tresso Cloud, or to your own server. It keeps itself up to date with signed updates.',
    available: 'Available',
    comingSoon: 'Coming soon',
    platforms: [
      { name: 'macOS', text: 'Apple Silicon and Intel, as a .dmg.', available: true },
      { name: 'Windows', text: 'x64, as an installer or .msi.', available: true },
      { name: 'Linux', text: 'x86_64 and arm64, as an AppImage or .deb.', available: true },
      { name: 'Web', text: 'Comes with every tresso server.', available: true },
      { name: 'iPhone and iPad', text: 'From the App Store.', available: false },
      { name: 'Android', text: 'From Google Play.', available: false },
    ],
    installTitle: 'Install with one command',
    installLead:
      'The install scripts check the download against the checksums of the release before they install anything. Run them again to upgrade in place.',
    installMac: 'macOS and Linux',
    installWindows: 'Windows (PowerShell)',
    releasesLink: 'All files on GitHub',
    macNote:
      'The macOS app is not signed with an Apple Developer ID yet. The install script handles that for you. When you open the .dmg yourself, right-click tresso and choose Open the first time.',
    selfHostTitle: 'Prefer your own server?',
    selfHostText: 'The same apps connect to any tresso server. Choose Use another server when you sign in.',
    selfHostCta: 'Self-host tresso',
  },
  notFound: {
    title: 'Page not found',
    heading: 'This page has no way out.',
    text: 'The page you are looking for does not exist or has moved.',
    cta: 'Back to home',
  },
};

export type Dict = typeof en;
