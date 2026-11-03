import {Injectable} from '@angular/core';
import {fetch} from '@tauri-apps/plugin-http';
import {Device} from '../types';
import {AppManagerService, InstallProgressHandler} from '../core/services/app-manager.service';
import {RemoteCommandService} from '../core/services/remote-command.service';
import {PackageManifest} from '../core/services/apps-repo.service';
import {DiscoverCore} from './discover-core';

/** One tracked link, as stored in the TV's sources.json (shared with Discoverium TV). */
export interface DiscoverEntry {
    url: string;
    appId: string;
    name: string;
    autoUpdate: boolean;
    prerelease: boolean;
    filter: string;
    added: number;
}

export interface DiscoverSettings {
    autoUpdate: boolean;
    intervalHours: number;
}

export interface DiscoverSources {
    format: number;
    settings: DiscoverSettings;
    apps: DiscoverEntry[];
}

export interface LatestRelease {
    version: string;
    tag: string | null;
    ipkUrl: string;
    ipkName: string;
    size: number;
    sha256: string | null;
    date: string | null;
    prerelease: boolean;
    page: string;
    notes: string;
}

export interface DiscoverRow {
    entry: DiscoverEntry;
    title: string;
    author: string;
    /** the TV's own icon for the app, when it is installed */
    iconUri: string | null;
    installed: string | null;
    latest: LatestRelease | null;
    /** installed, and a newer release exists */
    update: boolean;
    /** tracked but not on the TV: only installed when asked, never by "Update all" */
    install: boolean;
    newerThanRelease: boolean;
    error: string | null;
}

const UA = 'webOS-Discoverium/1.0 (Android)';

@Injectable({providedIn: 'root'})
export class DiscoverService {
    private latestCache = new Map<string, LatestRelease>();

    constructor(private cmd: RemoteCommandService, private appManager: AppManagerService) {
    }

    private http = {
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

    /** The shared list on the TV. A missing file is an empty list. */
    async readSources(device: Device): Promise<DiscoverSources> {
        const text = await this.cmd.exec(device, `cat ${DiscoverCore.SOURCES_FILE} 2>/dev/null || true`, 'utf-8');
        const empty = DiscoverCore.emptySources() as DiscoverSources;
        if (!text.trim()) return empty;
        try {
            const s = JSON.parse(text) as DiscoverSources;
            return {
                format: s.format ?? DiscoverCore.FORMAT,
                settings: {...empty.settings, ...(s.settings ?? {})},
                apps: Array.isArray(s.apps) ? s.apps : [],
            };
        } catch (e) {
            throw new Error('The list on the TV is damaged: ' + (e as Error).message);
        }
    }

    async writeSources(device: Device, sources: DiscoverSources): Promise<void> {
        // written through the shell (stdin to a temp file, then renamed) so a half-written list is never seen;
        // world-writable because the TV app's background job may run as another user
        const file = DiscoverCore.SOURCES_FILE, tmp = `${file}.phone`;
        await this.cmd.exec(device,
            `mkdir -p ${DiscoverCore.TV_DIR} && cat > ${tmp} && chmod 666 ${tmp} && mv ${tmp} ${file}`,
            'utf-8', JSON.stringify(sources, null, 1));
    }

    /** True when Discoverium TV's helper is on the TV, so it also updates by itself. */
    async tvHelperInstalled(device: Device): Promise<boolean> {
        const out = await this.cmd.exec(device,
            `[ -f ${DiscoverCore.TV_DIR}/bin/dtv.js ] && [ -f /var/lib/webosbrew/init.d/50-discoverium ] && echo yes || echo no`, 'utf-8')
            .catch(() => 'no');
        return out.trim() === 'yes';
    }

    async latest(entry: Pick<DiscoverEntry, 'url' | 'prerelease' | 'filter'>): Promise<LatestRelease> {
        return DiscoverCore.latest(entry, this.http) as Promise<LatestRelease>;
    }

    /** Installed version of every app on the TV, by app id */
    async installed(device: Device): Promise<Record<string, { version: string, title: string, iconUri?: string }>> {
        const pkgs = await this.appManager.list(device);
        const out: Record<string, { version: string, title: string, iconUri?: string }> = {};
        for (const p of pkgs) out[p.id] = {version: p.version, title: p.title, iconUri: p.iconUri};
        return out;
    }

    async rows(device: Device, sources: DiscoverSources, refresh: boolean): Promise<DiscoverRow[]> {
        const installed = await this.installed(device);
        const errors: Record<string, string> = {};
        await Promise.all(sources.apps.map(async e => {
            const key = e.appId || e.url;
            if (!refresh && this.latestCache.has(key)) return;
            try {
                this.latestCache.set(key, await this.latest(e));
            } catch (err) {
                errors[key] = (err as Error).message;
            }
        }));
        return sources.apps.map(e => {
            const key = e.appId || e.url;
            const latest = this.latestCache.get(key) ?? null;
            const have = installed[e.appId]?.version ?? null;
            const cmp = latest?.version && have ? DiscoverCore.compareVersions(latest.version, have) : null;
            return {
                entry: e,
                title: installed[e.appId]?.title || e.name || e.appId,
                author: DiscoverCore.author(e.url),
                iconUri: installed[e.appId]?.iconUri ?? null,
                installed: have,
                latest,
                update: !!latest?.version && !!have && (cmp ?? 0) > 0,
                install: !!latest?.version && !have,
                newerThanRelease: cmp !== null && cmp < 0,
                error: errors[key] ?? null,
            };
        });
    }

    /** Adds a link: finds its newest .ipk and reads the app id inside it. */
    async add(device: Device, input: string): Promise<DiscoverEntry> {
        const src = DiscoverCore.parseSource(input);
        const sources = await this.readSources(device);
        if (sources.apps.some(a => DiscoverCore.sourceKey(a.url) === DiscoverCore.sourceKey(src.url))) {
            throw new Error('That link is already in the list');
        }
        const latest = await this.latest({url: src.url, prerelease: false, filter: ''});
        // the app id is in the first part of the package; download it all only if that is not enough
        const get = async (range: boolean) => {
            const headers: Record<string, string> = {'User-Agent': UA};
            if (range) headers['Range'] = `bytes=0-${DiscoverCore.PROBE_BYTES - 1}`;
            const res = await fetch(latest.ipkUrl, {headers});
            if (!res.ok) throw new Error(`Could not download ${latest.ipkName} (HTTP ${res.status})`);
            return new Uint8Array(await res.arrayBuffer());
        };
        let info;
        try {
            info = await DiscoverCore.readIpkControl(await get(true), gunzip);
        } catch {
            info = await DiscoverCore.readIpkControl(await get(false), gunzip);
        }
        if (sources.apps.some(a => a.appId === info.id)) throw new Error(`${info.id} is already in the list`);
        const entry: DiscoverEntry = {
            url: src.url, appId: info.id, name: src.repo || info.id,
            autoUpdate: true, prerelease: false, filter: '', added: Date.now(),
        };
        sources.apps.push(entry);
        await this.writeSources(device, sources);
        this.latestCache.set(info.id, latest);
        return entry;
    }

    async remove(device: Device, appId: string): Promise<void> {
        const sources = await this.readSources(device);
        sources.apps = sources.apps.filter(a => a.appId !== appId);
        await this.writeSources(device, sources);
    }

    async setEntry(device: Device, appId: string, patch: Partial<DiscoverEntry>): Promise<void> {
        const sources = await this.readSources(device);
        const e = sources.apps.find(a => a.appId === appId);
        if (!e) throw new Error('Not in the list');
        Object.assign(e, patch);
        if (patch.prerelease !== undefined || patch.filter !== undefined) this.latestCache.delete(appId);
        await this.writeSources(device, sources);
    }

    async setSettings(device: Device, patch: Partial<DiscoverSettings>): Promise<void> {
        const sources = await this.readSources(device);
        Object.assign(sources.settings, patch);
        await this.writeSources(device, sources);
    }

    /** Installs one release with Dev Manager's own installer (Homebrew Channel or developer mode). */
    async install(device: Device, row: DiscoverRow, progress?: InstallProgressHandler): Promise<void> {
        const l = row.latest;
        if (!l) throw new Error('No release found for ' + row.title);
        const manifest = new PackageManifest({
            id: row.entry.appId, version: l.version, ipkUrl: l.ipkUrl,
            ipkHash: l.sha256 ? {sha256: l.sha256} : undefined,
            sourceUrl: row.entry.url, appDescription: row.title,
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
