import { en, type Dict } from './en';
import { nl } from './nl';

export const locales = ['en', 'nl'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

const dictionaries: Record<Locale, Dict> = { en, nl };

export type PageKey = 'home' | 'features' | 'pricing' | 'openSource' | 'download';

const pagePaths: Record<PageKey, string> = {
  home: '/',
  features: '/features/',
  pricing: '/pricing/',
  openSource: '/open-source/',
  download: '/download/',
};

/** getStaticPaths entries for a page that exists in every locale; the default locale has no prefix. */
export function localeStaticPaths() {
  return locales.map((locale) => ({
    params: { locale: locale === defaultLocale ? undefined : locale },
    props: { locale },
  }));
}

export function t(locale: Locale): Dict {
  return dictionaries[locale];
}

/** Absolute path of a page in the given locale, for example /nl/pricing/. */
export function pagePath(locale: Locale, page: PageKey): string {
  const path = pagePaths[page];
  return locale === defaultLocale ? path : `/${locale}${path}`;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}
