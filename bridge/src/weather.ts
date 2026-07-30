/**
 * Glance weather provider (Open-Meteo) — daemon-side module for the card-feed
 * sleep dashboard. The device never fetches weather itself; the daemon fetches,
 * caches, and pre-renders it into `CardFeedResponse.glance.weather`
 * (shared/src/protocol.ts § Glance).
 *
 * Open-Meteo is key-less and free for non-commercial local use; one bounded
 * request per cache window. Config comes from settings.json:
 *
 *   "weather": { "lat": 37.57, "lon": 126.98, "place": "Seoul" }
 *
 * No config → no weather in the glance (never a guess, never IP geolocation).
 */

import type { GlanceWeather, GlanceRainWindow, GlanceDayWeather } from '@agentdeck/shared';
import { GLANCE_RAIN_PROBABILITY_MIN } from '@agentdeck/shared';

export interface WeatherSettings {
  lat: number;
  lon: number;
  place?: string;
}

/** Serve from cache inside this window — weather cadence is slower than the
 *  fastest pull cadence (900s), so a fresh fetch per pull would be waste. */
export const WEATHER_CACHE_MS = 30 * 60 * 1000;
/** After a fetch failure, keep serving the last good report up to this age —
 *  a flaky WAN must degrade to slightly-old weather, not a blank panel. */
export const WEATHER_STALE_SERVE_MS = 3 * 60 * 60 * 1000;
/** External peer await — timeout is first-line, not optional. */
export const WEATHER_FETCH_TIMEOUT_MS = 5000;

export function parseWeatherSettings(settings: Record<string, unknown>): WeatherSettings | null {
  const w = settings?.weather as Record<string, unknown> | undefined;
  if (!w || typeof w !== 'object') return null;
  const lat = Number(w.lat);
  const lon = Number(w.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat,
    lon,
    ...(typeof w.place === 'string' && w.place ? { place: w.place } : {}),
  };
}

/** WMO weather interpretation code → one short summary word. Kept ASCII so
 *  every panel font can draw it; codes ride alongside for icon-capable
 *  clients. */
export function wmoSummary(code: number | undefined): string {
  if (code === undefined || !Number.isFinite(code)) return '';
  if (code === 0) return 'Clear';
  if (code <= 2) return 'Fair';
  if (code === 3) return 'Cloudy';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code === 85 || code === 86) return 'Snow';
  if (code >= 95) return 'Storm';
  return 'Cloudy';
}

/** Open-Meteo forecast subset we request (timezone=auto → local ISO times). */
interface OpenMeteoResponse {
  current?: { temperature_2m?: number; weather_code?: number };
  hourly?: { time?: string[]; precipitation_probability?: number[] };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_min?: number[];
    temperature_2m_max?: number[];
    precipitation_probability_max?: number[];
  };
}

export function buildForecastUrl(cfg: WeatherSettings): string {
  const p = new URLSearchParams({
    latitude: String(cfg.lat),
    longitude: String(cfg.lon),
    current: 'temperature_2m,weather_code',
    hourly: 'precipitation_probability',
    daily: 'weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '2',
  });
  return `https://api.open-meteo.com/v1/forecast?${p.toString()}`;
}

const hmOf = (iso: string): string => iso.slice(11, 16);
const dayOf = (iso: string): string => iso.slice(0, 10);

/** First remaining rain window today: contiguous hours ≥ the probability
 *  floor, starting from the current hour. */
export function findTodayRainWindow(
  hourly: { time?: string[]; precipitation_probability?: number[] } | undefined,
  now: Date,
): GlanceRainWindow | undefined {
  const times = hourly?.time ?? [];
  const probs = hourly?.precipitation_probability ?? [];
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const nowHm = `${String(now.getHours()).padStart(2, '0')}:00`;
  let start: string | undefined;
  let end: string | undefined;
  let peak = 0;
  for (let i = 0; i < times.length && i < probs.length; i++) {
    const t = times[i];
    if (dayOf(t) !== today) {
      if (start) break; // window ran to midnight
      continue;
    }
    const hm = hmOf(t);
    if (hm < nowHm) continue;
    const p = probs[i];
    if (typeof p === 'number' && p >= GLANCE_RAIN_PROBABILITY_MIN) {
      if (!start) start = hm;
      end = hm;
      if (p > peak) peak = p;
    } else if (start) {
      break; // window closed
    }
  }
  if (!start) return undefined;
  const win: GlanceRainWindow = { startHm: start, probability: Math.round(peak) };
  if (end && end !== start) win.endHm = end;
  return win;
}

export function toGlanceWeather(raw: OpenMeteoResponse, cfg: WeatherSettings, now: Date): GlanceWeather {
  const out: GlanceWeather = {};
  if (cfg.place) out.place = cfg.place;
  const cur = raw.current;
  if (cur && typeof cur.temperature_2m === 'number') out.tempC = Math.round(cur.temperature_2m);
  if (cur && typeof cur.weather_code === 'number') {
    out.code = cur.weather_code;
    out.summary = wmoSummary(cur.weather_code);
  }
  const d = raw.daily;
  if (d?.time?.length) {
    const todayMin = d.temperature_2m_min?.[0];
    const todayMax = d.temperature_2m_max?.[0];
    if (typeof todayMin === 'number') out.todayMinC = Math.round(todayMin);
    if (typeof todayMax === 'number') out.todayMaxC = Math.round(todayMax);
    if (d.time.length > 1) {
      const t: GlanceDayWeather = { summary: wmoSummary(d.weather_code?.[1]) };
      if (typeof d.weather_code?.[1] === 'number') t.code = d.weather_code[1];
      if (typeof d.temperature_2m_min?.[1] === 'number') t.minC = Math.round(d.temperature_2m_min[1]);
      if (typeof d.temperature_2m_max?.[1] === 'number') t.maxC = Math.round(d.temperature_2m_max[1]);
      if (typeof d.precipitation_probability_max?.[1] === 'number') {
        t.rainProbability = Math.round(d.precipitation_probability_max[1]);
      }
      out.tomorrow = t;
    }
  }
  const rain = findTodayRainWindow(raw.hourly, now);
  if (rain) out.rain = rain;
  return out;
}

interface CacheEntry {
  key: string;
  at: number;
  data: GlanceWeather;
}

export class WeatherProvider {
  private cache: CacheEntry | null = null;
  private inflight: Promise<GlanceWeather | undefined> | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Current weather for `cfg`, from cache when fresh. Resolves `undefined`
   *  when unconfigured or when no report (fresh or stale-servable) exists —
   *  the glance simply omits weather. Never throws. */
  async get(cfg: WeatherSettings | null, now: number = Date.now()): Promise<GlanceWeather | undefined> {
    if (!cfg) return undefined;
    const key = `${cfg.lat},${cfg.lon}`;
    const cached = this.cache;
    if (cached && cached.key === key && now - cached.at < WEATHER_CACHE_MS) return cached.data;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchFresh(cfg, key, now).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async fetchFresh(cfg: WeatherSettings, key: string, now: number): Promise<GlanceWeather | undefined> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), WEATHER_FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(buildForecastUrl(cfg), { signal: ctl.signal });
      if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
      const raw = (await res.json()) as OpenMeteoResponse;
      const data = toGlanceWeather(raw, cfg, new Date(now));
      this.cache = { key, at: now, data };
      return data;
    } catch (err) {
      this.log(`[weather] fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      const cached = this.cache;
      if (cached && cached.key === key && now - cached.at < WEATHER_STALE_SERVE_MS) return cached.data;
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
