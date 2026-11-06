/**
 * English copy. This is the source dictionary: every other locale must match its shape (see Dict).
 * Never use em or en dashes in copy. [PRICE] marks prices that are not decided yet.
 *
 * Keep statuses honest: 'available' is merged on main, 'review' has an open pull request,
 * 'progress' is being built, 'planned' is designed but not built yet.
 */
export type Verdict = 'do' | 'handOver' | 'know';
export type Edition = 'openSource' | 'cloud';
export type Status = 'available' | 'review' | 'progress' | 'planned';
export type PriceUnit = '' | 'perMonth' | 'perUserMonth';
export type PlanTarget = 'openSource' | 'download';

export const en = {
  langName: 'English',
  meta: {
    description:
      'tresso is an email client for all your accounts where every email is something to do, hand over or know. Open source and self-hostable, with a hosted tresso Cloud planned.',
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
    contact: 'Contact',
    license: 'Open source under AGPL-3.0. Shared libraries under MIT.',
    madeIn: 'Made in the Netherlands.',
  },
  verdicts: {
    do: 'Do',
    handOver: 'Hand over',
    know: 'Know',
  },
  editions: {
    openSource: 'Open source',
    cloud: 'Cloud',
  },
  statuses: {
    available: 'Available',
    review: 'In review',
    progress: 'In progress',
    planned: 'Planned',
  },
  repo: {
    link: 'View on GitHub',
    pending: 'The public repository opens at launch.',
  },
  home: {
    title: 'tresso: every email is something to do, hand over or know',
    status: 'Open source and in active development',
    heroTitle: 'Every email is something to do, hand over or know.',
    heroLead:
      'tresso is an email client and calendar for all your accounts that turns reading into deciding. Each message leaves your inbox as a todo, a handover to someone else, or a line in your daily brief.',
    ctaPrimary: 'Run it yourself',
    ctaSecondary: 'See all features',
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
      status: 'review' as Status,
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
      title: 'Built in the open, shipped in pieces.',
      lead: 'tresso is not released yet. This is what the open source code does today, what is being reviewed, and what is being built.',
      columns: [
        {
          status: 'available' as Status,
          items: [
            'Unified Inbox for IMAP, Gmail and Microsoft 365',
            'Search, compose, drafts and signatures',
            'Smart inboxes with rule-based classification',
            'Todos, with Make todo from any email',
            'Calendar with CalDAV, recurrence and invitations',
            'Reminders on every device',
            'Attachment virus scanning with quarantine',
            'Desktop app with a local copy of your mail',
            'Mobile app, including compose with files',
          ],
        },
        {
          status: 'review' as Status,
          items: [
            'Hand over with Waiting on and nudges',
            'Triage mode with D, H and K',
            'Daily brief with one-click Noted',
            'Batched delivery and one-click unsubscribe',
            'Push for mail that needs you',
            'Bulk cleanup by sender, smart inbox or age',
            'Calendar views, event editor and finding a time',
          ],
        },
        {
          status: 'progress' as Status,
          items: [
            'Per-user encryption of stored mail at rest',
            'Google and Microsoft calendars',
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
          text: 'Turn any email into a todo, or let a smart inbox do it for you. Todos live next to your mail and sync across devices.',
        },
        {
          title: 'Calendar included',
          text: 'Your CalDAV calendars with recurring events, invitations you answer from the email, and reminders on every device.',
        },
        {
          title: 'Search everything',
          text: 'Find any message across all your accounts.',
        },
        {
          title: 'Virus scanning',
          text: 'Attachments are scanned before anything can be opened. Infected files go to quarantine.',
        },
        {
          title: 'Every device',
          text: 'Web, desktop and mobile apps. The desktop app keeps a local copy of your mail, and the phone can write mail with files.',
        },
      ],
    },
    editions: {
      eyebrow: 'Two ways to run it',
      title: 'Host it yourself, or let us run it.',
      lead: 'The same client either way. The open source edition is complete on its own; tresso Cloud will add what needs a service behind it.',
      openSource: {
        name: 'tresso',
        label: 'Open source, self-hosted',
        text: 'A complete email client for one person. Run it on your own server with Docker.',
        points: [
          'All your accounts in one inbox',
          'Do, hand over, know, with todos and a daily brief',
          'Smart inboxes with your own rules',
          'Calendar with CalDAV and reminders',
          'Web, desktop and mobile apps',
          'AGPL-3.0, free forever',
        ],
        cta: 'Self-host tresso',
      },
      cloud: {
        name: 'tresso Cloud',
        label: 'Hosted by us, planned',
        text: 'Everything in the open source edition, run for you, plus the parts that need a service. Designed, not built yet.',
        points: [
          'AI classification that learns from you',
          'AI todo extraction and summaries in your brief',
          'Teams with shared inboxes and delegation',
          'REST API, webhooks and an MCP endpoint',
          'Statistics and your yearly Year in mail',
        ],
        cta: 'See Cloud plans',
      },
    },
    closing: {
      title: 'An inbox that empties on purpose.',
      lead: 'tresso is in active development. Downloads for web, desktop and mobile arrive with the first release.',
      cta: 'Get the apps',
    },
  },
  features: {
    title: 'Features',
    eyebrow: 'Features',
    heroTitle: 'Built around one question: what does this email need from you?',
    heroLead:
      'Everything in tresso serves the three verdicts. Each feature shows its edition and how far along it is. tresso is not released yet, so Available means it works in the open source code today.',
    legend: 'Edition',
    statusLegend: 'Status',
    groups: [
      {
        title: 'Inbox',
        items: [
          {
            title: 'Unified Inbox',
            text: 'IMAP and SMTP accounts, Gmail and Microsoft 365, together in one list with a reading pane.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Search',
            text: 'Search all your mail across every account.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Smart inboxes',
            text: 'To do, Informational, Notifications, Newsletters, Invitations and Spam, plus your own: a name, instructions and sender include and exclude lists, sorted by rules.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'AI classification',
            text: 'Smart inboxes sorted by AI instead of rules, learning from every correction you make.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Triage mode',
            text: 'One conversation at a time, settled with D, H or K.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
        ],
      },
      {
        title: 'Write',
        items: [
          {
            title: 'Compose, reply and forward',
            text: 'Write on any device, including on the phone with files attached. Drafts sync and are filed in your Drafts folder.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Signatures',
            text: 'An HTML signature per mail account, on every device.',
            edition: 'openSource' as Edition,
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
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Todos made for you',
            text: 'Let any smart inbox turn its mail into todos automatically.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Todo extraction',
            text: 'AI reads what is asked of you and writes the todo, due date included.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Hand over and Waiting on',
            text: 'Hand a conversation to someone with a note and a due date. tresso tracks it in Waiting on and nudges when it is late.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'Daily brief',
            text: 'Everything worth knowing in one calm overview. One click on Noted and it is done.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'AI summaries',
            text: 'Your daily brief, summarized: the gist of each email in a sentence.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
        ],
      },
      {
        title: 'Calendar',
        items: [
          {
            title: 'Calendar with CalDAV',
            text: 'Events with recurrence, synced with your CalDAV calendars. Answer invitations right from the email.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Reminders everywhere',
            text: 'Event reminders and notifications on web, desktop and mobile.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Calendar views and editor',
            text: 'Day, week, month and agenda views, and an event editor.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'Find a time',
            text: 'Pick a meeting time that works for everyone invited.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'Google and Microsoft calendars',
            text: 'Your Google Calendar and Outlook calendars next to CalDAV.',
            edition: 'openSource' as Edition,
            status: 'progress' as Status,
          },
        ],
      },
      {
        title: 'Quiet and tidy',
        items: [
          {
            title: 'Push for mail that needs you',
            text: 'Phone, desktop and browser notifications for mail to do or hand over. Everything else waits.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'Batched delivery',
            text: 'Newsletters and notifications arrive in batches, with one-click unsubscribe.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'Bulk actions',
            text: 'Select many conversations and archive, move, flag or delete them at once.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Cleanup suggestions',
            text: 'Clear out mail by sender, smart inbox or age, with suggestions for what can go.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
        ],
      },
      {
        title: 'Safe and everywhere',
        items: [
          {
            title: 'Attachment virus scanning',
            text: 'Every attachment is scanned before it can be opened. Infected files go to quarantine.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Encrypted credentials',
            text: 'The passwords and tokens for your mail accounts are stored encrypted.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Encryption at rest',
            text: 'All your stored mail, encrypted per user. Coming soon.',
            edition: 'openSource' as Edition,
            status: 'progress' as Status,
          },
          {
            title: 'Desktop app',
            text: 'A native desktop app with a local copy of your mail, native notifications and sign-in through your keychain.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Mobile app',
            text: 'Read, act on and write mail on your phone, with a local copy for speed.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
        ],
      },
      {
        title: 'Teams',
        items: [
          {
            title: 'Shared inboxes',
            text: 'Support, sales or info addresses handled together, with a clear owner for every email.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Delegation',
            text: 'Assign an email to a teammate inside tresso, discuss it in internal comments, and see who has how much on their plate.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
        ],
      },
      {
        title: 'Platform',
        items: [
          {
            title: 'REST API',
            text: 'Read mail, create todos and set verdicts from your own code, with API keys.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Webhooks',
            text: 'Tell your own systems when mail arrives or a verdict changes.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'MCP endpoint',
            text: 'Let other AI assistants search your mail and act on it, within the permissions you grant.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Developer tools',
            text: 'Tools for building on tresso and seeing what your integrations do.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
        ],
      },
      {
        title: 'Insight',
        items: [
          {
            title: 'Statistics',
            text: 'How much mail you get, from whom, and how quickly it leaves your inbox.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Year in mail',
            text: 'Once a year, a personal look back at your year in email.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
        ],
      },
    ],
    closingTitle: 'Want the full picture of each edition?',
    closingCta: 'Compare plans',
  },
  pricing: {
    title: 'Pricing',
    eyebrow: 'Pricing',
    heroTitle: 'Free to self-host. Fair to have hosted.',
    heroLead:
      'The open source edition costs nothing. tresso Cloud is planned as a subscription that pays for running it, and for building tresso.',
    perMonth: 'per month',
    perUserMonth: 'per user per month',
    free: 'Free',
    plans: [
      {
        name: 'Self-hosted',
        status: 'available' as Status,
        price: 'free',
        unit: '' as PriceUnit,
        text: 'The open source edition on your own server.',
        points: [
          'Complete email client for one person',
          'Do, hand over, know',
          'Todos, smart inboxes and search',
          'Calendar with CalDAV and reminders',
          'Attachment virus scanning',
          'Web, desktop and mobile apps',
          'Community support',
        ],
        cta: 'Self-host tresso',
        target: 'openSource' as PlanTarget,
      },
      {
        name: 'Cloud Personal',
        status: 'planned' as Status,
        price: '[PRICE]',
        unit: 'perMonth' as PriceUnit,
        text: 'tresso hosted for you, with AI and the platform.',
        points: [
          'Everything in Self-hosted, run for you',
          'AI classification and summaries',
          'AI todo extraction',
          'REST API, webhooks and MCP',
          'Developer tools',
          'Statistics and Year in mail',
        ],
        cta: 'Get the apps',
        target: 'download' as PlanTarget,
      },
      {
        name: 'Cloud Team',
        status: 'planned' as Status,
        price: '[PRICE]',
        unit: 'perUserMonth' as PriceUnit,
        text: 'For teams that share inboxes and hand work to each other.',
        points: [
          'Everything in Cloud Personal',
          'Teams and shared inboxes',
          'Delegation inside tresso',
          'Team statistics',
          'Priority support',
        ],
        cta: 'Get the apps',
        target: 'download' as PlanTarget,
      },
    ],
    note: 'tresso is not released yet. The open source edition can be self-hosted today; tresso Cloud and its prices are not final.',
    faqTitle: 'Questions',
    faq: [
      {
        q: 'Is the open source edition limited?',
        a: 'No. It is a complete email client for one person. tresso Cloud will add features that need a service behind them, like AI, teams and the API, but the open code never depends on them.',
      },
      {
        q: 'Which mail providers work with tresso?',
        a: 'Any IMAP and SMTP account, plus Gmail and Microsoft 365 through their own sign-in. When you self-host, Gmail and Microsoft 365 need an OAuth app that you register at Google and Microsoft.',
      },
      {
        q: 'Is my mail encrypted?',
        a: 'The credentials of your mail accounts are stored encrypted today. Per-user encryption of all stored mail at rest is being built.',
      },
      {
        q: 'Can I move from self-hosted to Cloud later?',
        a: 'That is the plan. Your accounts, todos and settings belong to you, in either direction.',
      },
    ],
  },
  openSource: {
    title: 'Open source',
    eyebrow: 'Open source',
    heroTitle: 'Your email client, on your own server.',
    heroLead:
      'tresso is open core. The open source edition is a complete, self-hostable email client for one person, licensed under AGPL-3.0.',
    licenseTitle: 'Licenses',
    licenses: [
      {
        name: 'AGPL-3.0',
        text: 'The tresso client, API and sync workers. Use it, change it, host it; share your changes when you offer it as a service.',
      },
      {
        name: 'MIT',
        text: 'The shared libraries in packages/, like domain types and the OAuth2 PKCE client. Use them in your own projects.',
      },
    ],
    includedTitle: 'What is in the open source edition',
    included: [
      'Accounts, mail, search and the Unified Inbox',
      'Smart inboxes with rules',
      'The three verdicts: do, hand over, know',
      'Todos, Waiting on and the daily brief',
      'Calendar with CalDAV, invitations and reminders',
      'Signatures and drafts, synced',
      'Attachment virus scanning',
      'Web, desktop and mobile apps',
    ],
    cloudTitle: 'What tresso Cloud will add',
    cloud: [
      'AI classification and summaries',
      'AI todo extraction',
      'Teams, shared inboxes and delegation',
      'REST API, webhooks and MCP endpoint',
      'Developer tools',
      'Statistics and Year in mail',
    ],
    addOnsTitle: 'Add-ons, not lock-in',
    addOnsText:
      'Cloud features attach as add-ons through two generic hooks. The open code defines each interface with a simple implementation, such as rule-based classification, and never depends on the Cloud. Anyone can build their own add-on the same way.',
    quickstartTitle: 'Run it yourself',
    quickstartLead: 'You need Docker and Node 24 or newer. Go and PHP run inside containers.',
    steps: [
      { title: 'Start the stack', code: 'docker compose up -d' },
      {
        title: 'Create your user',
        code: 'docker compose exec api php bin/console app:user:create you@example.com "Your Name"',
      },
      { title: 'Install and start the web app', code: 'npm install\nnpm run dev:web' },
    ],
    quickstartNote:
      'Then open http://localhost:5173 and sign in. For Gmail and Microsoft 365, register an OAuth app at Google and Microsoft first; without them, IMAP accounts work. Full instructions live in the repository.',
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
      'One account across web, desktop and mobile. The apps are built in the open; downloads arrive with the first release.',
    comingSoon: 'Coming soon',
    platforms: [
      { name: 'Web', text: 'Runs in any modern browser.' },
      { name: 'macOS', text: 'Native desktop app.' },
      { name: 'Windows', text: 'Native desktop app.' },
      { name: 'Linux', text: 'Native desktop app.' },
      { name: 'iPhone and iPad', text: 'From the App Store.' },
      { name: 'Android', text: 'From Google Play.' },
    ],
    selfHostTitle: 'Prefer your own server?',
    selfHostText: 'The open source edition runs anywhere Docker runs, and the same apps connect to it.',
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
