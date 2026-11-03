import {Injectable} from '@angular/core';
import {fetch} from '@tauri-apps/plugin-http';
import {Device} from '../types';
import {AppManagerService, InstallProgressHandler} from '../core/services/app-manager.service';
import {PackageManifest} from '../core/services/apps-repo.service';
import * as Releases from './release-core';
import {Release} from './release-core';

/** One app tracked by its release link. The list is kept on this phone, one list per TV. */
export interface TrackedApp {
    url: string;
    appId: string;
    name: string;
    prerelease: boolean;
    filter: string;
    added: number;
}

export interface UpdateRow {
    app: TrackedApp;
    title: string;
    author: string;
    /** the TV's own icon for the app, when it is installed and the TV is on */
    iconUri: string | null;
    installed: string | null;
    latest: Release | null;
    /** installed, and a newer release exists */
    update: boolean;
    /** tracked but not on the TV */
    install: boolean;
    newerThanRelease: boolean;
    error: string | null;
}

export interface UpdateRows {
    rows: UpdateRow[];
    /** the TV did not answer: installed versions are the last ones seen, nothing can be installed */
    offline: boolean;
}

interface InstalledApp {
    version: string;
    title: string;
    iconUri?: string;
}

const UA = 'WebOS-Homebrew-Fork/1.0 (Android)';

@Injectable({providedIn: 'root'})
export class UpdatesService {
    private latestCache = new Map<string, Release>();

    constructor(private appManager: AppManagerService) {
    }

    private http: Releases.JsonClient = {
        json: async (url: string): Promise<any> => {
            const res = await fetch(url, {headers: {'User-Agent': UA, 'Accept': 'application/json'}});
            if (!res.ok) {
                const hint = res.status === 403 && url.includes('api.github.com')
                    ? ' (GitHub\'s hourly limit for checks may be used up; try later)' : '';
                throw new Error(`HTTP ${res.status} from ${new URL(url).host}${hint}`);
            }
            return res.json();
        }
    };

    // ---- the list, stored on this phone --------------------------------------------------------

    private key(device: Device, what: string): string {
        return `homebrew-fork.${what}.${device.name}`;
    }

    private load<T>(device: Device, what: string, fallback: T): T {
        try {
            const text = localStorage.getItem(this.key(device, what));
            return text ? JSON.parse(text) as T : fallback;
        } catch {
            return fallback;
        }
    }

    private save(device: Device, what: string, value: unknown): void {
        localStorage.setItem(this.key(device, what), JSON.stringify(value));
    }

    apps(device: Device): TrackedApp[] {
        const list = this.load<TrackedApp[]>(device, 'apps', []);
        return Array.isArray(list) ? list : [];
    }

    private saveApps(device: Device, apps: TrackedApp[]): void {
        this.save(device, 'apps', apps);
    }

    /** Adds a link: finds its newest .ipk and reads the app id inside it. Needs the internet, not the TV. */
    async add(device: Device, input: string): Promise<TrackedApp> {
        const src = Releases.parseSource(input);
        const apps = this.apps(device);
        if (apps.some(a => Releases.sourceKey(a.url) === Releases.sourceKey(src.url))) {
            throw new Error('That link is already in the list');
        }
        const release = await this.latest({url: src.url, prerelease: false, filter: ''});
        // the app id is in the first part of the package; download it all only if that is not enough
        const get = async (range: boolean) => {
            const headers: Record<string, string> = {'User-Agent': UA};
            if (range) headers['Range'] = `bytes=0-${Releases.PROBE_BYTES - 1}`;
            const res = await fetch(release.ipkUrl, {headers});
            if (!res.ok) throw new Error(`Could not download ${release.ipkName} (HTTP ${res.status})`);
            return new Uint8Array(await res.arrayBuffer());
        };
        let info;
        try {
            info = await Releases.readIpkControl(await get(true), gunzip);
        } catch (e) {
            if (!(e instanceof Releases.TruncatedError)) throw e;
            info = await Releases.readIpkControl(await get(false), gunzip);
        }
        if (apps.some(a => a.appId === info.id)) throw new Error(`${info.id} is already in the list`);
        const app: TrackedApp = {
            url: src.url, appId: info.id, name: src.repo || src.project?.split('/').pop() || info.id,
            prerelease: false, filter: '', added: Date.now(),
        };
        this.saveApps(device, [...apps, app]);
        this.latestCache.set(info.id, release);
        return app;
    }

    remove(device: Device, appId: string): void {
        this.saveApps(device, this.apps(device).filter(a => a.appId !== appId));
    }

    update(device: Device, appId: string, patch: Partial<Pick<TrackedApp, 'prerelease' | 'filter'>>): void {
        this.latestCache.delete(appId);
        this.saveApps(device, this.apps(device).map(a => a.appId === appId ? {...a, ...patch} : a));
    }

    // ---- releases and the TV -------------------------------------------------------------------

    latest(entry: { url: string, prerelease?: boolean, filter?: string }): Promise<Release> {
        return Releases.latest(entry, this.http);
    }

    /** Installed versions from the TV; the last answer is remembered for when the TV is off */
    private async installed(device: Device): Promise<{ apps: Record<string, InstalledApp>, offline: boolean }> {
        try {
            const pkgs = await this.appManager.list(device);
            const apps: Record<string, InstalledApp> = {};
            for (const p of pkgs) apps[p.id] = {version: p.version, title: p.title, iconUri: p.iconUri};
            this.save(device, 'installed', Object.fromEntries(Object.entries(apps)
                .map(([id, a]) => [id, {version: a.version, title: a.title}])));
            return {apps, offline: false};
        } catch {
            return {apps: this.load<Record<string, InstalledApp>>(device, 'installed', {}), offline: true};
        }
    }

    async rows(device: Device, refresh: boolean): Promise<UpdateRows> {
        const apps = this.apps(device);
        const [{apps: installed, offline}] = await Promise.all([
            this.installed(device),
            Promise.all(apps.map(async a => {
                if (!refresh && this.latestCache.has(a.appId)) return;
                try {
                    this.latestCache.set(a.appId, await this.latest(a));
                    this.errors.delete(a.appId);
                } catch (err) {
                    this.errors.set(a.appId, (err as Error).message);
                }
            })),
        ]);
        const rows = apps.map((a): UpdateRow => {
            const latest = this.latestCache.get(a.appId) ?? null;
            const have = installed[a.appId]?.version ?? null;
            const cmp = latest?.version && have ? Releases.compareVersions(latest.version, have) : null;
            return {
                app: a,
                title: installed[a.appId]?.title || a.name || a.appId,
                author: Releases.author(a.url),
                iconUri: offline ? null : installed[a.appId]?.iconUri ?? null,
                installed: have,
                latest,
                update: !offline && !!latest?.version && !!have && (cmp ?? 0) > 0,
                install: !offline && !!latest?.version && !have,
                newerThanRelease: cmp !== null && cmp < 0,
                error: this.errors.get(a.appId) ?? null,
            };
        });
        return {rows, offline};
    }

    private errors = new Map<string, string>();

    /** Installs one release with Dev Manager's own installer (Homebrew Channel or developer mode). */
    async install(device: Device, row: UpdateRow, progress?: InstallProgressHandler): Promise<void> {
        const l = row.latest;
        if (!l) throw new Error('No release found for ' + row.title);
        const manifest = new PackageManifest({
            id: row.app.appId, version: l.version, ipkUrl: l.ipkUrl,
            ipkHash: l.sha256 ? {sha256: l.sha256} : undefined,
            sourceUrl: row.app.url, appDescription: row.title,
        });
        await this.appManager.installByManifest(device, manifest, progress);
    }
}

/**
 * Release notes are Markdown written by strangers: everything is escaped first, then only headings,
 * bullets, bold, inline code and http(s) links are turned back into markup.
 */
export function notesToHtml(md: string): string {
    const esc = (t: string) => t.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
    const inline = (t: string) => esc(t)
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" class="note-link">$1</a>');
    const out: string[] = [];
    let list = false;
    for (const raw of md.replace(/\r/g, '').split('\n')) {
        const line = raw.trimEnd();
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
            if (!list) { out.push('<ul>'); list = true; }
            out.push(`<li>${inline(bullet[1])}</li>`);
            continue;
        }
        if (list) { out.push('</ul>'); list = false; }
        const head = /^#{1,6}\s+(.*)$/.exec(line);
        if (head) out.push(`<div class="note-head">${inline(head[1])}</div>`);
        else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push('</ul>');
    return out.join('');
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
