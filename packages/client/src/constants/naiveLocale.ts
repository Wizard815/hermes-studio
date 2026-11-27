import { dateEnUS, enUS, type NDateLocale, type NLocale } from 'naive-ui'

export type NaiveLocaleConfig = {
  locale: NLocale
  dateLocale: NDateLocale
}

const EN: NaiveLocaleConfig = { locale: enUS, dateLocale: dateEnUS }

// English ships with the first page. Other languages load when chosen, so the
// first page does not carry every language's Naive UI and date-fns strings.
type Loader = () => Promise<[{ default: NLocale }, { default: NDateLocale }]>
const LOADERS: Record<string, Loader> = {
  zh: () => Promise.all([import('naive-ui/es/locales/common/zhCN'), import('naive-ui/es/locales/date/zhCN')]),
  'zh-tw': () => Promise.all([import('naive-ui/es/locales/common/zhTW'), import('naive-ui/es/locales/date/zhTW')]),
  ja: () => Promise.all([import('naive-ui/es/locales/common/jaJP'), import('naive-ui/es/locales/date/jaJP')]),
  ko: () => Promise.all([import('naive-ui/es/locales/common/koKR'), import('naive-ui/es/locales/date/koKR')]),
  de: () => Promise.all([import('naive-ui/es/locales/common/deDE'), import('naive-ui/es/locales/date/deDE')]),
  fr: () => Promise.all([import('naive-ui/es/locales/common/frFR'), import('naive-ui/es/locales/date/frFR')]),
  es: () => Promise.all([import('naive-ui/es/locales/common/esAR'), import('naive-ui/es/locales/date/esAR')]),
  pt: () => Promise.all([import('naive-ui/es/locales/common/ptBR'), import('naive-ui/es/locales/date/ptBR')]),
  ru: () => Promise.all([import('naive-ui/es/locales/common/ruRU'), import('naive-ui/es/locales/date/ruRU')]),
  tr: () => Promise.all([import('naive-ui/es/locales/common/trTR'), import('naive-ui/es/locales/date/trTR')]),
  ar: () => Promise.all([import('naive-ui/es/locales/common/arDZ'), import('naive-ui/es/locales/date/arDZ')]),
}

const loaded = new Map<string, NaiveLocaleConfig>([['en', EN]])

/** The Studio language key ('en', 'zh-tw', ...) whose Naive UI strings fit a locale. */
export function naiveLocaleKey(locale: string): string {
  const normalized = locale.trim().toLowerCase().replace(/_/g, '-')
  if (normalized === 'zh-tw' || normalized.startsWith('zh-hk')) return 'zh-tw'
  if (normalized in LOADERS) return normalized
  const base = normalized.split('-')[0]
  return base in LOADERS ? base : 'en'
}

/** The strings for a locale when they are loaded already; English until then. */
export function naiveLocaleFor(locale: string): NaiveLocaleConfig {
  return loaded.get(naiveLocaleKey(locale)) || EN
}

/** Loads a locale's strings once; English when the language has none or loading fails. */
export async function loadNaiveLocale(locale: string): Promise<NaiveLocaleConfig> {
  const key = naiveLocaleKey(locale)
  const ready = loaded.get(key)
  if (ready) return ready
  try {
    const [common, date] = await LOADERS[key]()
    const config = { locale: common.default, dateLocale: date.default }
    loaded.set(key, config)
    return config
  } catch {
    return EN
  }
}
