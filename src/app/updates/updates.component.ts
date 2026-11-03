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
import {notesToHtml, UpdateRow, UpdatesService} from './updates.service';

type View = 'list' | 'app' | 'add';

/**
 * Updates tab: tracks homebrew apps by their release links and updates them all at once. The list is kept
 * on this phone (one per TV); the TV is only needed to see installed versions and to install.
 */
@Component({
    selector: 'app-updates',
    imports: [FormsModule],
    templateUrl: './updates.component.html',
    styleUrl: './updates.component.scss',
    changeDetection: ChangeDetectionStrategy.Eager,
})
export class UpdatesComponent implements OnInit, OnDestroy {
    view: View = 'list';
    device: Device | null = null;
    rows: UpdateRow[] | null = null;
    selected: UpdateRow | null = null;
    offline = false;
    loading = false;
    checkedAt: number | null = null;
    error: string | null = null;
    addUrl = '';
    adding = false;
    addError: string | null = null;

    private sub?: Subscription;
    private retryTimer?: ReturnType<typeof setInterval>;
    private notesCache = new Map<string, SafeHtml>();

    constructor(private deviceManager: DeviceManagerService, private updates: UpdatesService,
                private modals: NgbModal, private cd: ChangeDetectorRef, private sanitizer: DomSanitizer) {
    }

    ngOnInit(): void {
        this.sub = this.deviceManager.selected$.subscribe(device => {
            this.device = device;
            this.rows = null;
            this.selected = null;
            this.offline = false;
            this.view = 'list';
            if (device) this.load(false);
        });
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
        clearInterval(this.retryTimer);
    }

    get pending(): UpdateRow[] {
        return (this.rows ?? []).filter(r => r.update);
    }

    /** Updates first, then by name */
    get sortedRows(): UpdateRow[] {
        return (this.rows ?? []).slice().sort((a, b) =>
            (Number(b.update) - Number(a.update)) || a.title.localeCompare(b.title));
    }

    /** Inner pages add a history entry, so the phone's Back button returns to the list */
    show(view: View, row?: UpdateRow): void {
        if (view !== 'list' && this.view === 'list') history.pushState({updatesView: view}, '');
        this.view = view;
        if (row) this.selected = row;
        if (view === 'add') this.addError = null;
        this.cd.markForCheck();
    }

    back(): void {
        if (history.state?.updatesView) history.back(); else this.show('list');
    }

    @HostListener('window:popstate')
    onPopState(): void {
        if (this.view !== 'list') {
            this.view = 'list';
            this.cd.markForCheck();
        }
    }

    async load(refresh: boolean): Promise<void> {
        const device = this.device;
        if (!device) return;
        this.loading = true;
        this.error = null;
        this.cd.markForCheck();
        try {
            const result = await this.updates.rows(device, refresh);
            this.rows = result.rows;
            this.offline = result.offline;
            if (this.selected) this.selected = this.rows.find(r => r.app.appId === this.selected!.app.appId) ?? null;
            if (this.view === 'app' && !this.selected) this.view = 'list';
            this.checkedAt = Date.now();
        } catch (e) {
            this.error = String((e as Error).message ?? e).slice(0, 300);
        } finally {
            this.loading = false;
            this.cd.markForCheck();
        }
        // while the TV is off, look again every 30 seconds so versions and installs come back by themselves
        clearInterval(this.retryTimer);
        this.retryTimer = this.offline ? setInterval(() => { if (!this.loading) this.load(false); }, 30000) : undefined;
    }

    async add(): Promise<void> {
        if (!this.device || !this.addUrl.trim()) return;
        this.adding = true;
        this.addError = null;
        this.cd.markForCheck();
        try {
            const app = await this.updates.add(this.device, this.addUrl.trim());
            this.addUrl = '';
            await this.load(false);
            const row = this.rows?.find(r => r.app.appId === app.appId);
            if (row) this.show('app', row); else this.back();
        } catch (e) {
            this.addError = String((e as Error).message ?? e).slice(0, 300);
        } finally {
            this.adding = false;
            this.cd.markForCheck();
        }
    }

    async install(rows: UpdateRow[]): Promise<void> {
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
                    await this.updates.install(device, r, (progress, status) =>
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

    async setOption(row: UpdateRow, patch: { prerelease?: boolean, filter?: string }): Promise<void> {
        if (!this.device) return;
        Object.assign(row.app, patch);
        this.updates.update(this.device, row.app.appId, patch);
        await this.load(true);
    }

    async remove(row: UpdateRow): Promise<void> {
        if (!this.device) return;
        const ok = await MessageDialogComponent.open(this.modals, {
            title: 'Remove app',
            message: `Stop tracking ${row.title}? The app itself stays installed on the TV.`,
            positive: 'Remove', positiveStyle: 'danger', negative: 'Cancel', autofocus: 'negative',
        }).result.catch(() => false);
        if (!ok) return;
        this.updates.remove(this.device, row.app.appId);
        this.selected = null;
        this.back();
        await this.load(false);
    }

    // ---- display helpers ------------------------------------------------------------------------

    icon(row: UpdateRow): SafeUrl | null {
        return row.iconUri ? this.sanitizer.bypassSecurityTrustUrl(row.iconUri) : null;
    }

    notes(row: UpdateRow): SafeHtml | null {
        const md = row.latest?.notes;
        if (!md?.trim()) return null;
        const key = `${row.app.appId}@${row.latest!.version}`;
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

    initial(row: UpdateRow): string {
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
