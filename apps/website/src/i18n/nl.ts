/**
 * Nederlandse tekst. Moet exact dezelfde vorm hebben als de Engelse brondictionary (zie Dict).
 * Gebruik nooit em- of en-streepjes in de tekst. [PRICE] markeert prijzen die nog niet vaststaan.
 *
 * Houd de statussen eerlijk en in lijn met docs/ROADMAP.md: 'available' staat op main, 'next' komt nog in een fase
 * die loopt, 'planned' staat op de roadmap maar is niet begonnen.
 */
import type { Dict, Verdict, Status, PlanTarget } from './en';

export const nl: Dict = {
  langName: 'Nederlands',
  meta: {
    description:
      'tresso is een open source e-mailclient en agenda voor al je accounts, waarin elke e-mail iets is om te doen, over te dragen of te weten. Gratis op je eigen server, of voor je gehost als tresso Cloud.',
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
    releases: 'Releases',
    contact: 'Contact',
    license: 'Open source onder AGPL-3.0.',
    madeIn: 'Gemaakt in Nederland.',
  },
  verdicts: {
    do: 'Doen',
    handOver: 'Overdragen',
    know: 'Weten',
  },
  statuses: {
    available: 'Beschikbaar',
    next: 'Komt hierna',
    planned: 'Gepland',
  },
  repo: {
    link: 'Bekijk op GitHub',
  },
  home: {
    title: 'tresso: elke e-mail is iets om te doen, over te dragen of te weten',
    status: 'Open source onder AGPL-3.0',
    heroTitle: 'Elke e-mail is iets om te doen, over te dragen of te weten.',
    heroLead:
      'tresso is een e-mailclient en agenda voor al je accounts die lezen verandert in beslissen. Elk bericht verlaat je inbox als todo, als overdracht aan iemand anders, of als regel in je dagelijkse briefing.',
    ctaPrimary: 'Download tresso',
    ctaSecondary: 'Draai je eigen server',
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
          doneWhen: 'Die persoon rondt het af. Tot die tijd houdt tresso het bij en geeft een seintje.',
        },
        know: {
          happens: 'Het komt in je dagelijkse briefing, samen met alles wat verder het weten waard is.',
          doneWhen: 'Je klikt op Noted. Eén klik en de hele briefing is afgehandeld.',
        },
      },
    },
    triage: {
      eyebrow: 'Triagemodus',
      title: 'Eén e-mail tegelijk. Eén toets per e-mail.',
      lead: 'De triagemodus toont één gesprek en wacht op jouw beslissing. Druk op D, H of K en de volgende verschijnt. Een drukke ochtendinbox wordt een paar minuten kiezen.',
      keys: [
        { key: 'D', verdict: 'do' as Verdict },
        { key: 'H', verdict: 'handOver' as Verdict },
        { key: 'K', verdict: 'know' as Verdict },
      ],
    },
    progress: {
      eyebrow: 'Waar het nu staat',
      title: 'Uitgebracht, en openlijk groeiend.',
      lead: 'tresso brengt vaak nieuwe releases uit. Dit is wat het vandaag doet, wat hierna komt en wat op de roadmap staat.',
      columns: [
        {
          status: 'available' as Status,
          items: [
            'Unified Inbox voor IMAP, Gmail en Microsoft 365',
            'Doen, overdragen, weten, met triagemodus',
            'Todos, Wacht op en de dagelijkse briefing',
            'Slimme inboxen met classificatie op basis van regels',
            'Agenda met CalDAV, Google en Microsoft',
            'Push alleen voor e-mail die jou nodig heeft',
            'Virusscan en versleuteling in rust per gebruiker',
            'Desktopapps met automatische updates',
            'Een MCP-endpoint voor je instellingen',
          ],
        },
        {
          status: 'next' as Status,
          items: [
            'Meldingsinstellingen voor de agenda en push op elk apparaat',
            'Morgen in één oogopslag en de week vooruit',
            'Ook onderwerpen en adressen versleuteld',
            'Hoe druk een dag is wanneer je een deadline kiest',
          ],
        },
        {
          status: 'planned' as Status,
          items: [
            'AI met je eigen sleutel of endpoint',
            'Teams met gedeelde inboxen en delegatie',
            'Webhooks en MCP-tools voor e-mail, todos en afspraken',
            'Statistieken en Year in mail',
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
          text: 'Maak van elke e-mail een todo, of laat een slimme inbox dat voor je doen. Geef een todo een duur en plan hem in je agenda.',
        },
        {
          title: 'Agenda inbegrepen',
          text: 'CalDAV-, Google- en Microsoft-agenda’s met online vergaderingen, uitnodigingen die je beantwoordt vanuit de e-mail en herinneringen.',
        },
        {
          title: 'Zoek in alles',
          text: 'Vind elk bericht in al je accounts, met filters voor afzender, map, bijlagen en datums.',
        },
        {
          title: 'Standaard veilig',
          text: 'Bijlagen worden gescand voordat ze geopend worden, en je opgeslagen e-mail is versleuteld per gebruiker.',
        },
        {
          title: 'Elk apparaat',
          text: 'Web- en desktopapps, en een mobiele app die onderweg is naar de stores. De desktopapp houdt een lokale kopie van je e-mail bij en updatet zichzelf.',
        },
      ],
    },
    hosting: {
      eyebrow: 'Twee manieren om het te draaien',
      title: 'Dezelfde code, elke functie. Jij kiest wie het draait.',
      lead: 'tresso is volledig open source. Draai het gratis op je eigen server, of laat ons het voor je hosten. Een abonnement betaalt de hosting, nooit functies.',
      selfHosted: {
        name: 'Zelf gehost',
        label: 'Op je eigen server',
        text: 'Heel tresso op een server die je zelf draait, met Docker.',
        points: [
          'Elke functie, gratis',
          'Productie-images voor amd64 en arm64',
          'Automatisch HTTPS en databasemigraties',
          'Je gegevens op je eigen hardware',
          'AGPL-3.0',
        ],
        cta: 'Host tresso zelf',
      },
      cloud: {
        name: 'tresso Cloud',
        label: 'Door ons gehost',
        text: 'Dezelfde code en dezelfde images, voor je gedraaid met back-ups en support.',
        points: [
          'Elke functie, niets om te draaien',
          '14 dagen gratis proefperiode, geen kaart nodig',
          'Eén abonnement per organisatie',
          'Back-ups, updates en support',
          'De standaardserver in de desktopapp',
        ],
        cta: 'Bekijk de prijzen',
      },
    },
    closing: {
      title: 'Een inbox die met opzet leegraakt.',
      lead: 'tresso draait vandaag op macOS, Windows en Linux. De apps updaten zichzelf.',
      cta: 'Download tresso',
    },
  },
  features: {
    title: 'Functies',
    eyebrow: 'Functies',
    heroTitle: 'Gebouwd rond één vraag: wat heeft deze e-mail van jou nodig?',
    heroLead:
      'Alles in tresso dient de drie oordelen, en alles is open source: zelf gehoste servers krijgen elke functie. Bij elke functie staat hoe ver ze is.',
    statusLegend: 'Status',
    groups: [
      {
        title: 'Inbox',
        items: [
          {
            title: 'Unified Inbox',
            text: 'IMAP- en SMTP-accounts, Gmail en Microsoft 365, samen in één lijst met een leesvenster.',
            status: 'available' as Status,
          },
          {
            title: 'Zoeken',
            text: 'Zoek in al je e-mail, over alle accounts heen, met filters als from:, to:, in:, has:attachment en datums.',
            status: 'available' as Status,
          },
          {
            title: 'Slimme inboxen',
            text: 'Te doen, Informatief, Meldingen, Nieuwsbrieven, Uitnodigingen en Spam, plus je eigen: een naam, instructies en lijsten met afzenders die je wel of juist niet wilt meenemen, gesorteerd op regels.',
            status: 'available' as Status,
          },
          {
            title: 'Triagemodus',
            text: 'Onbesliste mail, één gesprek tegelijk, afgehandeld met D, H of K.',
            status: 'available' as Status,
          },
          {
            title: 'AI-classificatie',
            text: 'Slimme inboxen gesorteerd door AI met je eigen sleutel of endpoint, en het leert van elke correctie die je maakt.',
            status: 'planned' as Status,
          },
        ],
      },
      {
        title: 'Schrijven',
        items: [
          {
            title: 'Opstellen, beantwoorden en doorsturen',
            text: 'Suggesties voor ontvangers, verzenden ongedaan maken en later verzenden. Concepten synchroniseren over apparaten en staan in je map Concepten.',
            status: 'available' as Status,
          },
          {
            title: 'Handtekeningen',
            text: 'Een HTML-handtekening per e-mailaccount, met een standaard voor elk, op elk apparaat.',
            status: 'available' as Status,
          },
          {
            title: 'Schrijven op je telefoon',
            text: 'Schrijf ook op je telefoon, met bijlagen.',
            status: 'available' as Status,
          },
        ],
      },
      {
        title: 'Doen, overdragen, weten',
        items: [
          {
            title: 'Ingebouwde todos',
            text: 'Maak van elke e-mail een todo met een deadline, gesynchroniseerd over je apparaten. Rond de todo af en de e-mail archiveert zichzelf.',
            status: 'available' as Status,
          },
          {
            title: 'Todos die voor je worden gemaakt',
            text: 'Laat elke slimme inbox zijn e-mail automatisch omzetten in todos.',
            status: 'available' as Status,
          },
          {
            title: 'Todos in je agenda',
            text: 'Geef een todo een duur en tresso plant hem in vrije tijd voordat hij af moet zijn, rond je werktijden, focusblokken en reistijd.',
            status: 'available' as Status,
          },
          {
            title: 'Overdragen en Wacht op',
            text: 'Draag een gesprek over aan iemand met een notitie en een deadline. tresso houdt het bij onder Wacht op en geeft een seintje als het te laat is.',
            status: 'available' as Status,
          },
          {
            title: 'Dagelijkse briefing',
            text: 'Alles wat het weten waard is in één rustig overzicht, één keer per dag op jouw tijdstip. Eén klik op Noted en het is klaar.',
            status: 'available' as Status,
          },
          {
            title: 'Drukte-hints',
            text: 'Zie hoe druk elke dag en elk uur al is wanneer je een deadline kiest.',
            status: 'next' as Status,
          },
          {
            title: 'AI-todos en samenvattingen',
            text: 'Todos geschreven op basis van wat een e-mail van je vraagt, en de kern van elke e-mail in je briefing, met je eigen AI-sleutel of endpoint.',
            status: 'planned' as Status,
          },
        ],
      },
      {
        title: 'Agenda',
        items: [
          {
            title: 'Je agenda’s',
            text: 'CalDAV, Google Agenda en Microsoft-agenda’s, met terugkerende afspraken en online vergaderingen.',
            status: 'available' as Status,
          },
          {
            title: 'Uitnodigingen',
            text: 'Beantwoord uitnodigingen direct vanuit de e-mail, en voeg afspraken toe die een e-mail voorstelt.',
            status: 'available' as Status,
          },
          {
            title: 'Agendaweergaven',
            text: 'Dag-, week-, maand- en agendaweergave, een afspraakeditor en een mini-agenda naast je e-mail. Agenda en afspraakdetails op je telefoon.',
            status: 'available' as Status,
          },
          {
            title: 'Herinneringen',
            text: 'Meerdere herinneringen per afspraak, in te stellen in de afspraakeditor en uitgesteld tijdens je stille uren. Instellingen voor standaardherinneringen en stille uren komen hierna.',
            status: 'available' as Status,
          },
          {
            title: 'Agendameldingen overal',
            text: 'Meldingsinstellingen voor de agenda, en agenda-push op web, desktop en mobiel.',
            status: 'next' as Status,
          },
          {
            title: 'Overzichten',
            text: 'Morgen in één oogopslag aan het eind van je werkdag, en de week vooruit.',
            status: 'next' as Status,
          },
        ],
      },
      {
        title: 'Rustig en opgeruimd',
        items: [
          {
            title: 'Push voor e-mail die jou nodig heeft',
            text: 'Meldingen op je telefoon, desktop en in de browser voor e-mail om te doen of over te dragen, uitgesteld tijdens vergaderingen en focusblokken.',
            status: 'available' as Status,
          },
          {
            title: 'Gebundelde bezorging',
            text: 'Nieuwsbrieven en meldingen komen gebundeld binnen, met uitschrijven in één klik.',
            status: 'available' as Status,
          },
          {
            title: 'Bulkacties',
            text: 'Selecteer veel gesprekken en archiveer, verplaats, markeer of verwijder ze in één keer.',
            status: 'available' as Status,
          },
          {
            title: 'Opruimsuggesties',
            text: 'Ruim e-mail op per afzender, slimme inbox of leeftijd, met suggesties voor wat weg kan.',
            status: 'available' as Status,
          },
        ],
      },
      {
        title: 'Veilig en privé',
        items: [
          {
            title: 'Virusscan op bijlagen',
            text: 'Elke bijlage wordt gescand voordat hij geopend kan worden. Besmette bestanden gaan in quarantaine.',
            status: 'available' as Status,
          },
          {
            title: 'Versleuteling in rust',
            text: 'Je opgeslagen e-mail, bijlagen en berichtteksten, versleuteld met sleutels per gebruiker. Ook wachtwoorden en tokens van accounts zijn versleuteld.',
            status: 'available' as Status,
          },
          {
            title: 'Meer versleuteling',
            text: 'Ook onderwerpen, adressen en namen beveiligd, en conceptteksten, overdrachtsnotities, afspraaknotities en todos.',
            status: 'next' as Status,
          },
        ],
      },
      {
        title: 'Elk apparaat',
        items: [
          {
            title: 'Desktopapps',
            text: 'macOS, Windows en Linux, met een lokale kopie van je e-mail, native meldingen en ondertekende updates die zichzelf installeren.',
            status: 'available' as Status,
          },
          {
            title: 'Web',
            text: 'Dezelfde client in elke moderne browser.',
            status: 'available' as Status,
          },
          {
            title: 'Mobiele app',
            text: 'Lees e-mail, handel hem af en schrijf, en bekijk je agenda op je telefoon, met een lokale kopie voor snelheid. Voorlopig bouw je hem vanuit de repository; releases in de App Store en Google Play komen eraan.',
            status: 'available' as Status,
          },
        ],
      },
      {
        title: 'Koppelen',
        items: [
          {
            title: 'MCP-endpoint',
            text: 'Laat Claude en andere MCP-clients je instellingen, handtekeningen, slimme inboxen en agenda’s aanpassen, alleen met de rechten die je geeft.',
            status: 'available' as Status,
          },
          {
            title: 'Toegangstokens en gekoppelde apps',
            text: 'Persoonlijke toegangstokens met gekozen rechten, en een lijst van de apps die je hebt toegestaan, om op elk moment los te koppelen.',
            status: 'available' as Status,
          },
          {
            title: 'MCP-tools voor e-mail, todos en afspraken',
            text: 'Laat AI-assistenten werken met je e-mail, todos en agenda, niet alleen met je instellingen.',
            status: 'planned' as Status,
          },
          {
            title: 'Webhooks en ontwikkelaarstools',
            text: 'Laat je eigen systemen weten wanneer er iets verandert, en zie wat je integraties doen.',
            status: 'planned' as Status,
          },
        ],
      },
      {
        title: 'Teams en inzicht',
        items: [
          {
            title: 'Organisaties',
            text: 'Elke gebruiker heeft een eigen organisatie, de basis voor teams en voor abonnementen.',
            status: 'available' as Status,
          },
          {
            title: 'Teams',
            text: 'Gedeelde inboxen, toewijzingen, interne opmerkingen, delegatieregels en werkverdeling.',
            status: 'planned' as Status,
          },
          {
            title: 'Statistieken en Year in mail',
            text: 'Hoe je e-mail stroomt, en één keer per jaar een persoonlijke terugblik op je jaar in e-mail.',
            status: 'planned' as Status,
          },
        ],
      },
    ],
    closingTitle: 'Draai het zelf, of laat ons het hosten.',
    closingCta: 'Bekijk de prijzen',
  },
  pricing: {
    title: 'Prijzen',
    eyebrow: 'Prijzen',
    heroTitle: 'Elke functie, waar het ook draait.',
    heroLead:
      'tresso zelf hosten is gratis. tresso Cloud is dezelfde code, voor je gehost: een abonnement betaalt het draaien, nooit functies.',
    free: 'Gratis',
    perMemberMonth: 'per lid per maand',
    plans: [
      {
        name: 'Zelf gehost',
        price: 'free',
        text: 'tresso op je eigen server.',
        points: [
          'Elke functie',
          'Web- en desktopapps',
          'Productie-images en een compose-bestand',
          'Je gegevens op je eigen hardware',
          'Ondersteuning door de community op GitHub',
        ],
        cta: 'Host tresso zelf',
        target: 'openSource' as PlanTarget,
      },
      {
        name: 'tresso Cloud',
        price: '[PRICE]',
        text: 'tresso voor je gehost, maandelijks of jaarlijks gefactureerd.',
        points: [
          'Elke functie',
          '14 dagen gratis proefperiode, geen kaart nodig',
          'Eén abonnement per organisatie, een plek per lid',
          'Back-ups, updates en support',
          'Betaal en beheer het in de app',
        ],
        cta: 'Vraag een account aan',
        target: 'contact' as PlanTarget,
      },
    ],
    note: 'De prijzen van tresso Cloud zijn nog niet definitief. Belasting wordt berekend bij het afrekenen.',
    faqTitle: 'Vragen',
    faq: [
      {
        q: 'Is zelf gehost tresso beperkt?',
        a: 'Nee. Alles wat tresso doet staat in de open source repository, en een zelf gehoste server heeft elke functie. Een server factureert alleen als facturatie is aangezet, en dat is standaard niet zo.',
      },
      {
        q: 'Hoe werkt de proefperiode?',
        a: 'Elke organisatie krijgt 14 dagen tresso Cloud gratis, zonder kaart. Voordat de proefperiode afloopt vraagt de app je om je te abonneren. Voorlopig worden accounts op tresso Cloud op aanvraag gemaakt: schrijf ons en wij zetten er een voor je klaar.',
      },
      {
        q: 'Wat gebeurt er als een abonnement eindigt?',
        a: 'tresso Cloud stopt met synchroniseren, versturen en melden voor die organisatie. Je gegevens blijven zoals ze zijn, en alles gaat weer door zodra er een abonnement actief is.',
      },
      {
        q: 'Wie betaalt?',
        a: 'Een abonnement hoort bij een organisatie, en de leden zijn de plekken. Eén persoon met meerdere e-mailaccounts betaalt één keer.',
      },
      {
        q: 'Welke e-mailproviders werken met tresso?',
        a: 'Elk IMAP- en SMTP-account, plus Gmail en Microsoft 365 via hun eigen aanmelding. Een zelf gehoste server heeft voor die twee een OAuth-app bij Google en Microsoft nodig.',
      },
      {
        q: 'Is mijn e-mail versleuteld?',
        a: 'Ja. Opgeslagen e-mail en bijlagen worden in rust versleuteld met sleutels per gebruiker, en ook wachtwoorden en tokens van accounts zijn versleuteld.',
      },
    ],
  },
  openSource: {
    title: 'Open source',
    eyebrow: 'Open source',
    heroTitle: 'Elke functie, op je eigen server.',
    heroLead:
      'Alles wat tresso doet is open source onder AGPL-3.0: de apps, de server en de gedeelde bibliotheken. Zelf draaien is gratis.',
    licenseTitle: 'Eén licentie, één repository',
    licenseName: 'AGPL-3.0',
    licenseText:
      'Gebruik tresso, pas het aan en host het. Wanneer je een aangepaste versie als dienst aanbiedt, deel je je aanpassingen onder dezelfde licentie.',
    cloudTitle: 'En tresso Cloud?',
    cloudText:
      'tresso Cloud draait dezelfde code en dezelfde images. Ook de facturatie zit in de repository, en staat alleen aan op de server die factureert. Een abonnement betaalt hosting, back-ups en support, nooit functies.',
    includedTitle: 'Wat zit er in de repository',
    included: [
      'De API, de sync-workers en de webclient',
      'De desktopapps voor macOS, Windows en Linux',
      'De mobiele app',
      'E-mail, zoeken, slimme inboxen en de drie oordelen',
      'Todos, Wacht op en de dagelijkse briefing',
      'Agenda en herinneringen',
      'Virusscan en versleuteling in rust',
      'Elke functie die nog komt',
    ],
    quickstartTitle: 'Draai het zelf',
    quickstartLead:
      'Je hebt een server met Docker nodig, twee DNS-namen die ernaar wijzen (een voor de webclient, een voor de API) en open poorten 80 en 443.',
    steps: [
      {
        title: 'Haal het compose-bestand op',
        text: 'Download compose.prod.yaml en .env.prod.example uit de repository naar één map.',
        code: '',
      },
      {
        title: 'Vul je instellingen in',
        text: 'Kopieer .env.prod.example naar .env en vul je twee adressen en elk geheim in. Bewaar een kopie van DATA_KEYS op een veilige plek: het versleutelt je e-mail in rust.',
        code: 'openssl rand -hex 32',
      },
      {
        title: 'Start het',
        text: '',
        code: 'docker compose -f compose.prod.yaml --env-file .env up -d',
      },
      {
        title: 'Maak je account aan',
        text: '',
        code: 'docker compose -f compose.prod.yaml exec api php bin/console app:user:create you@example.com "Your Name"',
      },
    ],
    quickstartNote:
      'De stack regelt zelf HTTPS-certificaten, migreert de database bij het starten en draait PostgreSQL, Redis, objectopslag, Meilisearch en ClamAV naast tresso. ClamAV heeft ongeveer 1,5 GB RAM nodig. Kies in de desktopapp voor Use another server en vul je API-adres in. De volledige instructies, ook voor Gmail en Microsoft 365, staan in de repository.',
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
      'De desktopapp meldt je aan bij tresso Cloud, of bij je eigen server. Hij houdt zichzelf up-to-date met ondertekende updates.',
    available: 'Beschikbaar',
    comingSoon: 'Binnenkort',
    platforms: [
      { name: 'macOS', text: 'Apple Silicon en Intel, als .dmg.', available: true },
      { name: 'Windows', text: 'x64, als installatieprogramma of .msi.', available: true },
      { name: 'Linux', text: 'x86_64 en arm64, als AppImage of .deb.', available: true },
      { name: 'Web', text: 'Zit bij elke tresso-server.', available: true },
      { name: 'iPhone en iPad', text: 'Uit de App Store.', available: false },
      { name: 'Android', text: 'Uit Google Play.', available: false },
    ],
    installTitle: 'Installeer met één opdracht',
    installLead:
      'De installatiescripts controleren de download aan de hand van de checksums van de release voordat ze iets installeren. Draai ze opnieuw om ter plekke te upgraden.',
    installMac: 'macOS en Linux',
    installWindows: 'Windows (PowerShell)',
    releasesLink: 'Alle bestanden op GitHub',
    macNote:
      'De macOS-app is nog niet ondertekend met een Apple Developer ID. Het installatiescript regelt dat voor je. Open je de .dmg zelf, klik dan de eerste keer met de rechtermuisknop op tresso en kies Open.',
    selfHostTitle: 'Liever je eigen server?',
    selfHostText: 'Dezelfde apps maken verbinding met elke tresso-server. Kies Use another server wanneer je je aanmeldt.',
    selfHostCta: 'Host tresso zelf',
  },
  notFound: {
    title: 'Pagina niet gevonden',
    heading: 'Deze pagina heeft geen uitweg.',
    text: 'De pagina die je zoekt bestaat niet of is verplaatst.',
    cta: 'Terug naar home',
  },
};
