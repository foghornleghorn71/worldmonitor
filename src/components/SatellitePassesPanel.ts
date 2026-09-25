import { Panel } from './Panel';
import { h } from '@/utils/dom-utils';
import {
  formatHomeLocation,
  getHomeLocation,
  parseHomeLocation,
  requestBrowserLocation,
  setHomeLocation,
  type HomeLocation,
} from '@/utils/home-location';
import { azimuthToCompass, type SatellitePass } from '@/services/satellite-passes';
import type { SatRecEntry } from '@/services/satellites';

const WINDOW_HOURS = 24;
const MIN_ELEVATION_DEG = 10;
const MAX_ROWS = 25;
/** TLE-based predictions drift; recompute well before they go stale. */
const RECOMPUTE_MS = 30 * 60 * 1000;
const RERENDER_MS = 30 * 1000;

const TYPE_LABEL: Record<string, string> = { sar: 'SAR', optical: 'Optical', military: 'Military' };

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRelative(ms: number, now: number): string {
  const minutes = Math.round((ms - now) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours} h ${minutes % 60} min`;
}

/**
 * Next overhead passes of the tracked reconnaissance / Earth-observation
 * satellites over a fixed home location (see utils/home-location).
 */
export class SatellitePassesPanel extends Panel {
  private home: HomeLocation | null = getHomeLocation();
  private satRecs: SatRecEntry[] = [];
  private passes: SatellitePass[] = [];
  private computedAt = 0;
  private status = '';
  private computing: AbortController | null = null;
  private recomputeTimer: ReturnType<typeof setInterval> | null = null;
  private rerenderTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onHomeChanged = () => {
    this.home = getHomeLocation();
    void this.recompute();
  };

  constructor() {
    super({
      id: 'satellite-passes',
      title: 'Satellite Passes',
      showCount: true,
      infoTooltip: `Next passes of the tracked reconnaissance and Earth-observation satellites over your home location within ${WINDOW_HOURS} h, at least ${MIN_ELEVATION_DEG}° above the horizon. Computed in the browser from public TLEs (CelesTrak) with SGP4. Most of these satellites are not visible to the naked eye.`,
    });
    window.addEventListener('wm:home-location', this.onHomeChanged);
    this.recomputeTimer = setInterval(() => { void this.recompute(); }, RECOMPUTE_MS);
    this.rerenderTimer = setInterval(() => this.render(), RERENDER_MS);
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    if (!this.home) return;
    this.status = 'Loading satellite data…';
    this.render();
    try {
      const { fetchSatelliteTLEs, initSatRecs } = await import('@/services/satellites');
      const tles = await fetchSatelliteTLEs();
      if (!tles || tles.length === 0) {
        this.status = 'No satellite data available right now.';
        this.render();
        return;
      }
      this.satRecs = await initSatRecs(tles);
      await this.recompute();
    } catch {
      this.status = 'Could not load satellite data.';
      this.render();
    }
  }

  private async recompute(): Promise<void> {
    if (!this.home) {
      this.passes = [];
      this.render();
      return;
    }
    if (this.satRecs.length === 0) {
      await this.load();
      return;
    }
    this.computing?.abort();
    const controller = new AbortController();
    this.computing = controller;
    this.status = 'Computing passes…';
    this.render();
    try {
      const [{ ensureSatelliteLib }, { predictPasses }] = await Promise.all([
        import('@/services/satellites'),
        import('@/services/satellite-passes'),
      ]);
      const lib = await ensureSatelliteLib();
      const passes = await predictPasses(lib, this.satRecs, this.home, {
        hours: WINDOW_HOURS,
        minElevationDeg: MIN_ELEVATION_DEG,
        signal: controller.signal,
      });
      if (this.computing !== controller) return;
      this.passes = passes;
      this.computedAt = Date.now();
      this.status = '';
      this.setCount(passes.filter((p) => p.setAt > Date.now()).length);
      this.render();
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      this.status = 'Pass computation failed.';
      this.render();
    }
  }

  private renderLocationForm(): HTMLElement {
    const input = h('input', {
      type: 'text',
      className: 'satellite-passes-home-input',
      placeholder: 'lat,lon e.g. 48.137,11.575',
      'aria-label': 'Home location as latitude,longitude',
      value: this.home ? formatHomeLocation(this.home) : '',
    }) as HTMLInputElement;
    const message = h('span', { className: 'satellite-passes-form-message', role: 'status' });
    const save = () => {
      const parsed = parseHomeLocation(input.value);
      if (!parsed) {
        message.textContent = 'Use the form lat,lon with decimal degrees.';
        return;
      }
      setHomeLocation(parsed);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    const locate = h('button', {
      type: 'button',
      className: 'satellite-passes-button',
      onClick: async () => {
        message.textContent = 'Requesting location…';
        try {
          setHomeLocation(await requestBrowserLocation());
        } catch (error) {
          message.textContent = (error as Error).message;
        }
      },
    }, 'Use my location');
    return h('div', { className: 'satellite-passes-form', style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px' },
      input,
      h('button', { type: 'button', className: 'satellite-passes-button', onClick: save }, 'Set home'),
      locate,
      message,
    );
  }

  private renderRow(pass: SatellitePass, now: number): HTMLElement {
    const overhead = pass.riseAt <= now && pass.setAt > now;
    const durationMin = Math.max(1, Math.round((pass.setAt - pass.riseAt) / 60_000));
    const cell = 'padding:4px 6px 4px 0;vertical-align:top';
    const sub = 'opacity:.7;font-size:11px';
    return h('tr', { className: overhead ? 'satellite-pass-row satellite-pass-overhead' : 'satellite-pass-row', style: overhead ? 'font-weight:600' : '' },
      h('td', { style: cell }, formatClock(pass.riseAt), h('div', { style: sub }, overhead ? 'overhead now' : formatRelative(pass.riseAt, now))),
      h('td', { style: cell }, pass.name, h('div', { style: sub }, `${TYPE_LABEL[pass.type] ?? pass.type} · ${pass.country}`)),
      h('td', { style: `${cell};white-space:nowrap` },
        `${Math.round(pass.maxElevationDeg)}° · ${durationMin} min`,
        h('div', { style: sub }, `${azimuthToCompass(pass.riseAzimuthDeg)} → ${azimuthToCompass(pass.setAzimuthDeg)}`)),
    );
  }

  private render(): void {
    // Keep a half-typed location intact: skip periodic repaints while the
    // form has focus.
    if (this.content.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return;
    const form = this.renderLocationForm();
    if (!this.home) {
      this.setContentNodes(form, h('div', { className: 'panel-empty' }, 'Set a home location to see which satellites pass over it. You can also open the page with ?home=lat,lon.'));
      return;
    }
    const now = Date.now();
    const upcoming = this.passes.filter((p) => p.setAt > now).slice(0, MAX_ROWS);
    const footer = h('div', { style: 'opacity:.7;font-size:11px;margin-top:6px' },
      this.computedAt
        ? `Next ${WINDOW_HOURS} h, ≥${MIN_ELEVATION_DEG}° elevation, ${this.satRecs.length} satellites · computed ${formatClock(this.computedAt)}`
        : '');
    if (this.status) {
      this.setContentNodes(form, h('div', { className: 'panel-empty' }, this.status), footer);
      return;
    }
    if (upcoming.length === 0) {
      this.setContentNodes(form, h('div', { className: 'panel-empty' }, `No passes above ${MIN_ELEVATION_DEG}° in the next ${WINDOW_HOURS} h.`), footer);
      return;
    }
    const table = h('table', { className: 'satellite-passes-table', style: 'width:100%;border-collapse:collapse;font-size:12px' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', style: 'text-align:left;padding:0 6px 4px 0' }, 'Rise'),
        h('th', { scope: 'col', style: 'text-align:left;padding:0 6px 4px 0' }, 'Satellite'),
        h('th', { scope: 'col', style: 'text-align:left;padding:0 6px 4px 0' }, 'Pass'),
      )),
      h('tbody', null, ...upcoming.map((pass) => this.renderRow(pass, now))),
    );
    this.setContentNodes(form, table, footer);
  }

  public override destroy(): void {
    window.removeEventListener('wm:home-location', this.onHomeChanged);
    this.computing?.abort();
    if (this.recomputeTimer) clearInterval(this.recomputeTimer);
    if (this.rerenderTimer) clearInterval(this.rerenderTimer);
    super.destroy();
  }
}

