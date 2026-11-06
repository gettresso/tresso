/**
 * Nederlandse tekst. Moet exact dezelfde vorm hebben als de Engelse brondictionary (zie Dict).
 * Gebruik nooit em- of en-streepjes in de tekst. [PRICE] markeert prijzen die nog niet vaststaan.
 *
 * Houd de statussen eerlijk: 'available' staat op main, 'review' heeft een open pull request,
 * 'progress' wordt gebouwd, 'planned' is ontworpen maar nog niet gebouwd.
 */
import type { Dict, Verdict, Edition, Status, PriceUnit, PlanTarget } from './en';

export const nl: Dict = {
  langName: 'Nederlands',
  meta: {
    description:
      'tresso is een e-mailclient voor al je accounts waarin elke e-mail iets is om te doen, over te dragen of te weten. Open source en zelf te hosten, met een gehoste tresso Cloud in de planning.',
  },
  nav: {
    features: 'Functies',
    pricing: 'Prijzen',
    openSource: 'Open source',
    download: 'Download',
    menu: 'Menu',
    language: 'Taal',
    skip: 'Ga naar de inhoud',
    home: 'tresso startpagina',
  },
  footer: {
    tagline: 'Eén T, drie uitwegen.',
    product: 'Product',
    project: 'Project',
    contact: 'Contact',
    license: 'Open source onder AGPL-3.0. Gedeelde bibliotheken onder MIT.',
    madeIn: 'Gemaakt in Nederland.',
  },
  verdicts: {
    do: 'Doen',
    handOver: 'Overdragen',
    know: 'Weten',
  },
  editions: {
    openSource: 'Open source',
    cloud: 'Cloud',
  },
  statuses: {
    available: 'Beschikbaar',
    review: 'In review',
    progress: 'In ontwikkeling',
    planned: 'Gepland',
  },
  repo: {
    link: 'Bekijk op GitHub',
    pending: 'De publieke repository gaat open bij de lancering.',
  },
  home: {
    title: 'tresso: elke e-mail is iets om te doen, over te dragen of te weten',
    status: 'Open source en in actieve ontwikkeling',
    heroTitle: 'Elke e-mail is iets om te doen, over te dragen of te weten.',
    heroLead:
      'tresso is een e-mailclient en agenda voor al je accounts die lezen verandert in beslissen. Elk bericht verlaat je inbox als todo, als overdracht aan iemand anders, of als regel in je dagelijkse briefing.',
    ctaPrimary: 'Draai het zelf',
    ctaSecondary: 'Bekijk alle functies',
    demo: {
      label: 'Voorbeeld van een Unified Inbox met een oordeel bij elke e-mail',
      title: 'Unified Inbox',
      accounts: '3 accounts',
      keysHint: 'Handel elke e-mail af met één toets',
      unread: 'Ongelezen',
      rows: [
        {
          from: 'Lena Hartmann',
          subject: 'Contractverlenging: handtekening nodig voor vrijdag',
          verdict: 'do' as Verdict,
          note: 'Todo, uiterlijk vr',
          time: '09:12',
          unread: true,
        },
        {
          from: 'Support queue',
          subject: 'Klant kan de facturen van vorige maand niet exporteren',
          verdict: 'handOver' as Verdict,
          note: 'Aan Sam, uiterlijk wo',
          time: '08:47',
          unread: true,
        },
        {
          from: 'Product Weekly',
          subject: 'Wat er deze week is uitgebracht',
          verdict: 'know' as Verdict,
          note: 'In je briefing',
          time: '07:30',
          unread: false,
        },
        {
          from: 'Pieter de Vries',
          subject: 'Kun je de Q3-presentatie bekijken voor donderdag?',
          verdict: 'do' as Verdict,
          note: 'Todo, uiterlijk do',
          time: 'Gisteren',
          unread: false,
        },
        {
          from: 'Gebouwbeheer',
          subject: 'Onderhoud aan de lift op donderdagochtend',
          verdict: 'know' as Verdict,
          note: 'In je briefing',
          time: 'Gisteren',
          unread: false,
        },
      ],
    },
    ways: {
      eyebrow: 'Het idee',
      title: 'Eén T, drie uitwegen.',
      lead: 'Het tresso-logo is een T van drie balken. Elke balk is een manier waarop een e-mail je inbox kan verlaten. Niets blijft zomaar liggen.',
      happens: 'Wat er gebeurt',
      doneWhen: 'Klaar wanneer',
      items: {
        do: {
          happens: 'Het wordt een todo, gekoppeld aan de e-mail, met een deadline als die er is.',
          doneWhen: 'De todo is afgerond. De e-mail archiveert zichzelf.',
        },
        handOver: {
          happens: 'Het gaat met een notitie en een deadline naar iemand anders en wacht onder Wacht op.',
          doneWhen: 'Die persoon rondt het af. Tot die tijd houdt tresso het bij en geeft een duwtje.',
        },
        know: {
          happens: 'Het komt in je dagelijkse briefing, samen met alles wat verder het weten waard is.',
          doneWhen: 'Je klikt op Gezien. Eén klik en de hele briefing is afgehandeld.',
        },
      },
    },
    triage: {
      eyebrow: 'Triagemodus',
      status: 'review' as Status,
      title: 'Eén e-mail tegelijk. Eén toets per e-mail.',
      lead: 'De triagemodus toont één e-mail en wacht op jouw beslissing. Druk op D, H of K en de volgende verschijnt. Een drukke ochtendinbox wordt een paar minuten kiezen.',
      keys: [
        { key: 'D', verdict: 'do' as Verdict },
        { key: 'H', verdict: 'handOver' as Verdict },
        { key: 'K', verdict: 'know' as Verdict },
      ],
    },
    progress: {
      eyebrow: 'Waar het nu staat',
      title: 'Openlijk gebouwd, in stukken opgeleverd.',
      lead: 'tresso is nog niet uitgebracht. Dit is wat de open source code nu doet, wat wordt beoordeeld en wat wordt gebouwd.',
      columns: [
        {
          status: 'available' as Status,
          items: [
            'Unified Inbox voor IMAP, Gmail en Microsoft 365',
            'Zoeken, schrijven, concepten en handtekeningen',
            'Slimme inboxen met classificatie op basis van regels',
            'Todos, met Maak todo vanuit elke e-mail',
            'Agenda met CalDAV, herhaling en uitnodigingen',
            'Herinneringen op elk apparaat',
            'Virusscan op bijlagen met quarantaine',
            'Desktopapp met een lokale kopie van je e-mail',
            'Mobiele app, ook om te schrijven met bijlagen',
          ],
        },
        {
          status: 'review' as Status,
          items: [
            'Overdragen met Wacht op en duwtjes',
            'Triagemodus met D, H en K',
            'Dagelijkse briefing met Gezien in één klik',
            'Gebundelde bezorging en uitschrijven met één klik',
            'Push voor e-mail die jou nodig heeft',
            'Bulksgewijs opruimen op afzender, slimme inbox of leeftijd',
            'Agendaweergaven, afspraakeditor en een tijdstip vinden',
          ],
        },
        {
          status: 'progress' as Status,
          items: [
            'Versleuteling per gebruiker van opgeslagen e-mail',
            'Google- en Microsoft-agenda’s',
          ],
        },
      ],
      more: 'Volg het op GitHub',
    },
    highlights: {
      eyebrow: 'Binnenin',
      title: 'Alles wat een e-mailclient moet kunnen, en voor elk bericht een duidelijke volgende stap.',
      more: 'Alle functies',
      items: [
        {
          title: 'Unified Inbox',
          text: 'IMAP-accounts, Gmail en Microsoft 365 in één inbox, gesorteerd in slimme inboxen: Te doen, Informatief, Meldingen, Nieuwsbrieven, Uitnodigingen en Spam.',
        },
        {
          title: 'Ingebouwde todos',
          text: 'Maak van elke e-mail een todo, of laat een slimme inbox dat voor je doen. Todos staan naast je e-mail en synchroniseren op elk apparaat.',
        },
        {
          title: 'Agenda inbegrepen',
          text: 'Je CalDAV-agenda’s met terugkerende afspraken, uitnodigingen die je beantwoordt vanuit de e-mail en herinneringen op elk apparaat.',
        },
        {
          title: 'Zoek in alles',
          text: 'Vind elk bericht in al je accounts.',
        },
        {
          title: 'Virusscan',
          text: 'Bijlagen worden gescand voordat ze geopend kunnen worden. Besmette bestanden gaan in quarantaine.',
        },
        {
          title: 'Elk apparaat',
          text: 'Web-, desktop- en mobiele apps. De desktopapp houdt een lokale kopie van je e-mail bij, en op je telefoon schrijf je ook e-mail met bijlagen.',
        },
      ],
    },
    editions: {
      eyebrow: 'Twee manieren om het te draaien',
      title: 'Host het zelf, of laat ons het draaien.',
      lead: 'Dezelfde client, op beide manieren. De open source editie is op zichzelf compleet. tresso Cloud voegt toe wat een dienst erachter nodig heeft.',
      openSource: {
        name: 'tresso',
        label: 'Open source, zelf gehost',
        text: 'Een complete e-mailclient voor één persoon. Draai hem op je eigen server met Docker.',
        points: [
          'Al je accounts in één inbox',
          'Doen, overdragen, weten, met todos en een dagelijkse briefing',
          'Slimme inboxen met je eigen regels',
          'Agenda met CalDAV en herinneringen',
          'Web-, desktop- en mobiele apps',
          'AGPL-3.0, voor altijd gratis',
        ],
        cta: 'Host tresso zelf',
      },
      cloud: {
        name: 'tresso Cloud',
        label: 'Door ons gehost, gepland',
        text: 'Alles uit de open source editie, voor je gedraaid, plus de onderdelen die een dienst nodig hebben. Ontworpen, nog niet gebouwd.',
        points: [
          'AI-classificatie die van jou leert',
          'AI-todo-extractie en samenvattingen in je briefing',
          'Teams met gedeelde inboxen en delegatie',
          'REST API, webhooks en een MCP-endpoint',
          'Statistieken en je jaarlijkse Year in mail',
        ],
        cta: 'Bekijk de Cloud-abonnementen',
      },
    },
    closing: {
      title: 'Een inbox die met opzet leegraakt.',
      lead: 'tresso is in actieve ontwikkeling. Downloads voor web, desktop en mobiel komen met de eerste release.',
      cta: 'Haal de apps',
    },
  },
  features: {
    title: 'Functies',
    eyebrow: 'Functies',
    heroTitle: 'Gebouwd rond één vraag: wat heeft deze e-mail van jou nodig?',
    heroLead:
      'Alles in tresso dient de drie oordelen. Bij elke functie staat de editie en hoe ver ze is. tresso is nog niet uitgebracht, dus Beschikbaar betekent dat het vandaag werkt in de open source code.',
    legend: 'Editie',
    statusLegend: 'Status',
    groups: [
      {
        title: 'Inbox',
        items: [
          {
            title: 'Unified Inbox',
            text: 'IMAP- en SMTP-accounts, Gmail en Microsoft 365, samen in één lijst met een leesvenster.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Zoeken',
            text: 'Zoek in al je e-mail, over alle accounts heen.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Slimme inboxen',
            text: 'Te doen, Informatief, Meldingen, Nieuwsbrieven, Uitnodigingen en Spam, plus je eigen: een naam, instructies en lijsten met afzenders om te includeren en te excluderen, gesorteerd op regels.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'AI-classificatie',
            text: 'Slimme inboxen gesorteerd door AI in plaats van regels, en het leert van elke correctie die je maakt.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Triagemodus',
            text: 'Eén e-mail tegelijk, afgehandeld met D, H of K.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
        ],
      },
      {
        title: 'Schrijven',
        items: [
          {
            title: 'Opstellen, beantwoorden en doorsturen',
            text: 'Schrijf op elk apparaat, ook op je telefoon met bijlagen. Concepten synchroniseren en staan in je map Concepten.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Handtekeningen',
            text: 'Een HTML-handtekening per e-mailaccount, op elk apparaat.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
        ],
      },
      {
        title: 'Doen, overdragen, weten',
        items: [
          {
            title: 'Ingebouwde todos',
            text: 'Maak todo vanuit elke e-mail, met een deadline, gesynchroniseerd over je apparaten. Rond de todo af en de e-mail archiveert zichzelf.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Todos die voor je worden gemaakt',
            text: 'Laat elke slimme inbox zijn e-mail automatisch omzetten in todos.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Todo-extractie',
            text: 'AI leest wat er van je gevraagd wordt en schrijft de todo, inclusief deadline.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Overdragen en Wacht op',
            text: 'Draag een gesprek over aan iemand met een notitie en een deadline. tresso houdt het bij onder Wacht op en geeft een seintje als het te laat is.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'Dagelijkse briefing',
            text: 'Alles wat het weten waard is in één rustig overzicht. Eén klik op Gezien en het is klaar.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'AI-samenvattingen',
            text: 'Je dagelijkse briefing, samengevat: de kern van elke e-mail in één zin.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
        ],
      },
      {
        title: 'Agenda',
        items: [
          {
            title: 'Agenda met CalDAV',
            text: 'Afspraken met herhaling, gesynchroniseerd met je CalDAV-agenda’s. Beantwoord uitnodigingen direct vanuit de e-mail.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Herinneringen overal',
            text: 'Herinneringen en meldingen voor afspraken op web, desktop en mobiel.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Agendaweergaven en editor',
            text: 'Dag-, week-, maand- en agendaweergave, en een afspraakeditor.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'Een tijdstip vinden',
            text: 'Kies een tijdstip voor een afspraak dat voor iedereen die is uitgenodigd past.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'Google- en Microsoft-agenda’s',
            text: 'Je Google Agenda en Outlook-agenda’s naast CalDAV.',
            edition: 'openSource' as Edition,
            status: 'progress' as Status,
          },
        ],
      },
      {
        title: 'Rustig en opgeruimd',
        items: [
          {
            title: 'Push voor e-mail die jou nodig heeft',
            text: 'Meldingen op je telefoon, desktop en in de browser voor e-mail om te doen of over te dragen. Al het andere wacht.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'Gebundelde bezorging',
            text: 'Nieuwsbrieven en meldingen komen gebundeld binnen, met uitschrijven in één klik.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
          {
            title: 'Bulkacties',
            text: 'Selecteer veel gesprekken en archiveer, verplaats, markeer of verwijder ze in één keer.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Opruimsuggesties',
            text: 'Ruim e-mail op per afzender, slimme inbox of leeftijd, met suggesties voor wat weg kan.',
            edition: 'openSource' as Edition,
            status: 'review' as Status,
          },
        ],
      },
      {
        title: 'Veilig en overal',
        items: [
          {
            title: 'Virusscan op bijlagen',
            text: 'Elke bijlage wordt gescand voordat hij geopend kan worden. Besmette bestanden gaan in quarantaine.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Versleutelde inloggegevens',
            text: 'De wachtwoorden en tokens van je e-mailaccounts worden versleuteld opgeslagen.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Versleuteling in rust',
            text: 'Al je opgeslagen e-mail, versleuteld per gebruiker. Binnenkort.',
            edition: 'openSource' as Edition,
            status: 'progress' as Status,
          },
          {
            title: 'Desktopapp',
            text: 'Een native desktopapp met een lokale kopie van je e-mail, native meldingen en aanmelden via je sleutelhanger.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
          {
            title: 'Mobiele app',
            text: 'Lees e-mail, handel hem af en schrijf op je telefoon, met een lokale kopie voor snelheid.',
            edition: 'openSource' as Edition,
            status: 'available' as Status,
          },
        ],
      },
      {
        title: 'Teams',
        items: [
          {
            title: 'Gedeelde inboxen',
            text: 'Support-, sales- of info-adressen samen afgehandeld, met een duidelijke eigenaar voor elke e-mail.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Delegatie',
            text: 'Wijs een e-mail toe aan een teamgenoot binnen tresso, bespreek hem in interne opmerkingen en zie wie hoeveel op zijn bord heeft.',
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
            text: 'Lees e-mail, maak todos en stel oordelen in vanuit je eigen code, met API-sleutels.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Webhooks',
            text: 'Laat je eigen systemen weten wanneer er e-mail binnenkomt of een oordeel verandert.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'MCP-endpoint',
            text: 'Laat andere AI-assistenten in je e-mail zoeken en erop handelen, binnen de rechten die je geeft.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Ontwikkelaarstools',
            text: 'Tools om op tresso te bouwen en te zien wat je integraties doen.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
        ],
      },
      {
        title: 'Inzicht',
        items: [
          {
            title: 'Statistieken',
            text: 'Hoeveel e-mail je krijgt, van wie, en hoe snel die je inbox verlaat.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
          {
            title: 'Year in mail',
            text: 'Eén keer per jaar een persoonlijke terugblik op je jaar in e-mail.',
            edition: 'cloud' as Edition,
            status: 'planned' as Status,
          },
        ],
      },
    ],
    closingTitle: 'Wil je het volledige beeld van elke editie?',
    closingCta: 'Vergelijk abonnementen',
  },
  pricing: {
    title: 'Prijzen',
    eyebrow: 'Prijzen',
    heroTitle: 'Gratis om zelf te hosten. Eerlijk om te laten hosten.',
    heroLead:
      'De open source editie kost niets. tresso Cloud is gepland als abonnement dat het draaien betaalt, en het bouwen van tresso.',
    perMonth: 'per maand',
    perUserMonth: 'per gebruiker per maand',
    free: 'Gratis',
    plans: [
      {
        name: 'Zelf gehost',
        status: 'available' as Status,
        price: 'free',
        unit: '' as PriceUnit,
        text: 'De open source editie op je eigen server.',
        points: [
          'Complete e-mailclient voor één persoon',
          'Doen, overdragen, weten',
          'Todos, slimme inboxen en zoeken',
          'Agenda met CalDAV en herinneringen',
          'Virusscan op bijlagen',
          'Web-, desktop- en mobiele apps',
          'Ondersteuning door de community',
        ],
        cta: 'Host tresso zelf',
        target: 'openSource' as PlanTarget,
      },
      {
        name: 'Cloud Personal',
        status: 'planned' as Status,
        price: '[PRICE]',
        unit: 'perMonth' as PriceUnit,
        text: 'tresso voor je gehost, met AI en het platform.',
        points: [
          'Alles uit Zelf gehost, voor je gedraaid',
          'AI-classificatie en samenvattingen',
          'AI-todo-extractie',
          'REST API, webhooks en MCP',
          'Ontwikkelaarstools',
          'Statistieken en Year in mail',
        ],
        cta: 'Haal de apps',
        target: 'download' as PlanTarget,
      },
      {
        name: 'Cloud Team',
        status: 'planned' as Status,
        price: '[PRICE]',
        unit: 'perUserMonth' as PriceUnit,
        text: 'Voor teams die inboxen delen en werk aan elkaar overdragen.',
        points: [
          'Alles uit Cloud Personal',
          'Teams en gedeelde inboxen',
          'Delegatie binnen tresso',
          'Teamstatistieken',
          'Voorrangsondersteuning',
        ],
        cta: 'Haal de apps',
        target: 'download' as PlanTarget,
      },
    ],
    note: 'tresso is nog niet uitgebracht. De open source editie kun je vandaag zelf hosten. tresso Cloud en de prijzen zijn nog niet definitief.',
    faqTitle: 'Vragen',
    faq: [
      {
        q: 'Is de open source editie beperkt?',
        a: 'Nee. Het is een complete e-mailclient voor één persoon. tresso Cloud voegt functies toe die een dienst erachter nodig hebben, zoals AI, teams en de API, maar de open code is daar nooit van afhankelijk.',
      },
      {
        q: 'Welke e-mailproviders werken met tresso?',
        a: 'Elk IMAP- en SMTP-account, plus Gmail en Microsoft 365 via hun eigen aanmelding. Als je zelf host, heb je voor Gmail en Microsoft 365 een OAuth-app nodig die je registreert bij Google en Microsoft.',
      },
      {
        q: 'Is mijn e-mail versleuteld?',
        a: 'De inloggegevens van je e-mailaccounts worden vandaag versleuteld opgeslagen. Versleuteling per gebruiker van al je opgeslagen e-mail wordt gebouwd.',
      },
      {
        q: 'Kan ik later van zelf gehost naar Cloud overstappen?',
        a: 'Dat is het plan. Je accounts, todos en instellingen zijn van jou, in beide richtingen.',
      },
    ],
  },
  openSource: {
    title: 'Open source',
    eyebrow: 'Open source',
    heroTitle: 'Jouw e-mailclient, op je eigen server.',
    heroLead:
      'tresso is open core. De open source editie is een complete, zelf te hosten e-mailclient voor één persoon, onder de AGPL-3.0-licentie.',
    licenseTitle: 'Licenties',
    licenses: [
      {
        name: 'AGPL-3.0',
        text: 'De tresso-client, API en sync-workers. Gebruik het, pas het aan, host het. Deel je aanpassingen wanneer je het als dienst aanbiedt.',
      },
      {
        name: 'MIT',
        text: 'De gedeelde bibliotheken in packages/, zoals domeintypes en de OAuth2 PKCE-client. Gebruik ze in je eigen projecten.',
      },
    ],
    includedTitle: 'Wat zit er in de open source editie',
    included: [
      'Accounts, e-mail, zoeken en de Unified Inbox',
      'Slimme inboxen met regels',
      'De drie oordelen: doen, overdragen, weten',
      'Todos, Wacht op en de dagelijkse briefing',
      'Agenda met CalDAV, uitnodigingen en herinneringen',
      'Handtekeningen en concepten, gesynchroniseerd',
      'Virusscan op bijlagen',
      'Web-, desktop- en mobiele apps',
    ],
    cloudTitle: 'Wat tresso Cloud gaat toevoegen',
    cloud: [
      'AI-classificatie en samenvattingen',
      'AI-todo-extractie',
      'Teams, gedeelde inboxen en delegatie',
      'REST API, webhooks en MCP-endpoint',
      'Ontwikkelaarstools',
      'Statistieken en Year in mail',
    ],
    addOnsTitle: 'Add-ons, geen lock-in',
    addOnsText:
      'Cloud-functies sluiten aan als add-ons via twee generieke hooks. De open code definieert elke interface met een eenvoudige implementatie, zoals classificatie op basis van regels, en is nooit afhankelijk van de Cloud. Iedereen kan op dezelfde manier een eigen add-on bouwen.',
    quickstartTitle: 'Draai het zelf',
    quickstartLead: 'Je hebt Docker en Node 24 of nieuwer nodig. Go en PHP draaien in containers.',
    steps: [
      { title: 'Start de stack', code: 'docker compose up -d' },
      {
        title: 'Maak je gebruiker aan',
        code: 'docker compose exec api php bin/console app:user:create you@example.com "Your Name"',
      },
      { title: 'Installeer en start de webapp', code: 'npm install\nnpm run dev:web' },
    ],
    quickstartNote:
      'Open daarna http://localhost:5173 en meld je aan. Voor Gmail en Microsoft 365 registreer je eerst een OAuth-app bij Google en Microsoft. Zonder die apps werken IMAP-accounts wel. De volledige instructies staan in de repository.',
    stackTitle: 'Gebouwd met',
    stack: [
      { part: 'API', tech: 'PHP en Symfony op FrankenPHP' },
      { part: 'Sync-workers', tech: 'Go' },
      { part: 'Web', tech: 'Vue en TypeScript' },
      { part: 'Desktop', tech: 'Tauri' },
      { part: 'Mobiel', tech: 'Expo' },
      { part: 'Data', tech: 'PostgreSQL, Redis, S3-opslag, Meilisearch' },
      { part: 'Scannen', tech: 'ClamAV' },
    ],
  },
  download: {
    title: 'Download',
    eyebrow: 'Download',
    heroTitle: 'tresso op elk scherm dat je gebruikt.',
    heroLead:
      'Eén account voor web, desktop en mobiel. De apps worden openlijk gebouwd. Downloads komen met de eerste release.',
    comingSoon: 'Binnenkort',
    platforms: [
      { name: 'Web', text: 'Draait in elke moderne browser.' },
      { name: 'macOS', text: 'Native desktop-app.' },
      { name: 'Windows', text: 'Native desktop-app.' },
      { name: 'Linux', text: 'Native desktop-app.' },
      { name: 'iPhone en iPad', text: 'Uit de App Store.' },
      { name: 'Android', text: 'Uit Google Play.' },
    ],
    selfHostTitle: 'Liever je eigen server?',
    selfHostText: 'De open source editie draait overal waar Docker draait, en dezelfde apps maken er verbinding mee.',
    selfHostCta: 'Host tresso zelf',
  },
  notFound: {
    title: 'Pagina niet gevonden',
    heading: 'Deze pagina heeft geen uitweg.',
    text: 'De pagina die je zoekt bestaat niet of is verplaatst.',
    cta: 'Terug naar home',
  },
};
