import {ChangeDetectionStrategy, ChangeDetectorRef, Component, HostListener, OnDestroy, OnInit} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {DomSanitizer, SafeHtml, SafeUrl} from '@angular/platform-browser';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {open as openExternal} from '@tauri-apps/plugin-shell';
import {Subscription} from 'rxjs';
import {Device} from '../types';
import {DeviceManagerService} from '../core/services';
import {MessageDialogComponent} from '../shared/components/message-dialog/message-dialog.component';
import {ProgressDialogComponent} from '../shared/components/progress-dialog/progress-dialog.component';
import {DiscoverRow, DiscoverService, DiscoverSettings, notesToHtml} from './discover.service';

type View = 'apps' | 'app' | 'add' | 'settings';

/**
 * Discoverium for webOS, laid out like the Discoverium/Obtainium apps: an apps list, an app page with
 * release notes, an "Add app" page and settings. The list itself lives on the TV, shared with the
 * Discoverium TV app, and only holds links the user adds.
 */
@Component({
    selector: 'app-discover',
    imports: [FormsModule],
    templateUrl: './discover.component.html',
    styleUrl: './discover.component.scss',
    changeDetection: ChangeDetectionStrategy.Eager,
})
export class DiscoverComponent implements OnInit, OnDestroy {
    view: View = 'apps';
    device: Device | null = null;
    rows: DiscoverRow[] | null = null;
    selected: DiscoverRow | null = null;
    settings: DiscoverSettings | null = null;
    tvHelper: boolean | null = null;
    loading = false;
    checkedAt: number | null = null;
    error: string | null = null;
    addUrl = '';
    adding = false;
    addError: string | null = null;
    readonly intervals = [6, 12, 24, 48, 168];

    private sub?: Subscription;
    private notesCache = new Map<string, SafeHtml>();

    constructor(private deviceManager: DeviceManagerService, private discover: DiscoverService,
                private modals: NgbModal, private cd: ChangeDetectorRef, private sanitizer: DomSanitizer) {
    }

    ngOnInit(): void {
        this.sub = this.deviceManager.selected$.subscribe(device => {
            this.device = device;
            this.rows = null;
            this.selected = null;
            this.tvHelper = null;
            this.view = 'apps';
            if (device) this.load(false);
        });
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    get updates(): DiscoverRow[] {
        return (this.rows ?? []).filter(r => r.update);
    }

    /** Updates first, then by name, like Discoverium's default order */
    get sortedRows(): DiscoverRow[] {
        return (this.rows ?? []).slice().sort((a, b) =>
            (Number(b.update) - Number(a.update)) || a.title.localeCompare(b.title));
    }

    /** Inner pages add a history entry, so the phone's Back button returns to the list */
    show(view: View, row?: DiscoverRow): void {
        if (view !== 'apps' && this.view === 'apps') history.pushState({discover: view}, '');
        this.view = view;
        if (row) this.selected = row;
        if (view === 'add') this.addError = null;
        this.cd.markForCheck();
    }

    back(): void {
        if (history.state?.discover) history.back(); else this.show('apps');
    }

    @HostListener('window:popstate')
    onPopState(): void {
        if (this.view !== 'apps') { this.view = 'apps'; this.cd.markForCheck(); }
    }

    async load(refresh: boolean): Promise<void> {
        const device = this.device;
        if (!device) return;
        this.loading = true;
        this.error = null;
        this.cd.markForCheck();
        try {
            const sources = await this.discover.readSources(device);
            this.settings = sources.settings;
            this.rows = await this.discover.rows(device, sources, refresh);
            if (this.selected) this.selected = this.rows.find(r => r.entry.appId === this.selected!.entry.appId) ?? null;
            if (this.view === 'app' && !this.selected) this.view = 'apps';
            this.tvHelper = await this.discover.tvHelperInstalled(device);
            this.checkedAt = Date.now();
        } catch (e) {
            this.error = String((e as Error).message ?? e).slice(0, 300);
        } finally {
            this.loading = false;
            this.cd.markForCheck();
        }
    }

    async add(): Promise<void> {
        if (!this.device || !this.addUrl.trim()) return;
        this.adding = true;
        this.addError = null;
        this.cd.markForCheck();
        try {
            const entry = await this.discover.add(this.device, this.addUrl.trim());
            this.addUrl = '';
            await this.load(false);
            const row = this.rows?.find(r => r.entry.appId === entry.appId);
            this.show(row ? 'app' : 'apps', row);
        } catch (e) {
            this.addError = String((e as Error).message ?? e).slice(0, 300);
        } finally {
            this.adding = false;
            this.cd.markForCheck();
        }
    }

    async install(rows: DiscoverRow[]): Promise<void> {
        const device = this.device;
        if (!device || !rows.length) return;
        const ref = ProgressDialogComponent.open(this.modals);
        const dialog = ref.componentInstance as ProgressDialogComponent;
        const failed: string[] = [];
        try {
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                const prefix = rows.length > 1 ? `(${i + 1}/${rows.length}) ` : '';
                dialog.update(`${prefix}${r.title} ${r.latest?.version ?? ''}`);
                try {
                    await this.discover.install(device, r, (progress, status) =>
                        dialog.update(`${prefix}${r.title}: ${status ?? ''}`, progress));
                } catch (e) {
                    failed.push(`${r.title}: ${(e as Error).message ?? e}`);
                }
            }
        } finally {
            ref.close(true);
        }
        if (failed.length) {
            MessageDialogComponent.open(this.modals, {
                title: failed.length === rows.length ? 'Update failed' : 'Some updates failed',
                message: failed.join('\n'),
                positive: 'OK',
            });
        }
        await this.load(false);
    }

    async setEntry(row: DiscoverRow, patch: { autoUpdate?: boolean, prerelease?: boolean, filter?: string }): Promise<void> {
        if (!this.device) return;
        Object.assign(row.entry, patch);
        try {
            await this.discover.setEntry(this.device, row.entry.appId, patch);
            if (patch.prerelease !== undefined || patch.filter !== undefined) await this.load(true);
        } catch (e) {
            this.error = String((e as Error).message ?? e).slice(0, 300);
        }
        this.cd.markForCheck();
    }

    async remove(row: DiscoverRow): Promise<void> {
        if (!this.device) return;
        const ok = await MessageDialogComponent.open(this.modals, {
            title: 'Remove app',
            message: `Stop tracking ${row.title}? The app itself stays installed on the TV.`,
            positive: 'Remove', positiveStyle: 'danger', negative: 'Cancel', autofocus: 'negative',
        }).result.catch(() => false);
        if (!ok) return;
        await this.discover.remove(this.device, row.entry.appId).catch(e => this.error = (e as Error).message);
        this.selected = null;
        this.back();
        await this.load(false);
    }

    async setSetting(patch: Partial<DiscoverSettings>): Promise<void> {
        if (!this.device || !this.settings) return;
        Object.assign(this.settings, patch);
        await this.discover.setSettings(this.device, patch).catch(e => this.error = (e as Error).message);
        this.cd.markForCheck();
    }

    // ---- display helpers ------------------------------------------------------------------------

    icon(row: DiscoverRow): SafeUrl | null {
        return row.iconUri ? this.sanitizer.bypassSecurityTrustUrl(row.iconUri) : null;
    }

    notes(row: DiscoverRow): SafeHtml | null {
        const md = row.latest?.notes;
        if (!md?.trim()) return null;
        const key = `${row.entry.appId}@${row.latest!.version}`;
        let html = this.notesCache.get(key);
        if (!html) {
            html = this.sanitizer.bypassSecurityTrustHtml(notesToHtml(md));
            this.notesCache.set(key, html);
        }
        return html;
    }

    date(iso: string | null | undefined): string {
        if (!iso) return '';
        const d = new Date(iso);
        return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
    }

    time(ms: number | null): string {
        if (!ms) return 'never';
        const d = new Date(ms), p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    hoursLabel(h: number): string {
        return h >= 168 ? 'Every week' : h >= 48 ? `Every ${h / 24} days` : h === 24 ? 'Every day' : `Every ${h} hours`;
    }

    initial(row: DiscoverRow): string {
        return (row.title || '?').charAt(0).toUpperCase();
    }

    /** Links (source page, release, links inside release notes) open in the phone's browser */
    openLink(url: string | null | undefined, event?: Event): void {
        event?.preventDefault();
        if (url && /^https?:\/\//.test(url)) openExternal(url).catch(() => window.open(url, '_blank'));
    }

    notesClick(event: Event): void {
        const a = (event.target as HTMLElement).closest('a.note-link') as HTMLAnchorElement | null;
        if (a) this.openLink(a.getAttribute('href'), event);
    }
}
