import definePlugin from "@utils/types";
import { ChannelStore, Constants, RestAPI, SelectedChannelStore } from "@webpack/common";

const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 150;
const CHUNK_SIZE = 50000;
const PARALLELISM = 5;
const BAR_SELECTOR = 'div[class*="channelTextArea"]';
const DISCORD_EPOCH = 1420070400000n;

interface DiscordAttachment {
    id: string;
    filename: string;
    url: string;
    proxy_url: string;
    content_type?: string;
    width?: number | null;
    height?: number | null;
    size: number;
}

interface DiscordMessage {
    id: string;
    content: string;
    timestamp: string;
    author: { id: string; username: string; discriminator: string; };
    message_reference?: { message_id: string; };
    referenced_message?: { author: { username: string; }; };
    attachments?: DiscordAttachment[];
    embeds?: { type?: string; url?: string; image?: { url: string; proxyURL?: string; width?: number; height?: number; }; thumbnail?: { url: string; proxyURL?: string; width?: number; height?: number; }; }[];
    thread?: { id: string; };
}

interface AttachmentExport {
    url: string;
    proxyUrl: string;
    filename: string;
    contentType: string | null;
    width: number | null;
    height: number | null;
}

interface ExportRow {
    id: string;
    author: string;
    content: string;
    timestamp: string;
    replyTo: string | null;
    replyToAuthor: string | null;
    attachments: number;
    attachmentUrls: string[];
    imageUrls: string[];
    attachmentsDetailed: AttachmentExport[];
    threadId: string | null;
}

function toExportRow(m: DiscordMessage): ExportRow {
    const atts = m.attachments ?? [];
    const detailed: AttachmentExport[] = atts.map(a => ({
        url: a.url,
        proxyUrl: a.proxy_url,
        filename: a.filename,
        contentType: a.content_type ?? null,
        width: a.width ?? null,
        height: a.height ?? null,
    }));
    const attachmentUrls = detailed.map(d => d.url);
    const imageUrls = [
        ...detailed.filter(d => d.contentType?.startsWith("image/")).map(d => d.url),
        ...(m.embeds ?? [])
            .filter(e => e.image?.url || e.thumbnail?.url)
            .map(e => e.image?.url ?? e.thumbnail!.url!),
    ];
    return {
        id: m.id,
        author: `${m.author.username}#${m.author.discriminator} (${m.author.id})`,
        content: m.content,
        timestamp: m.timestamp,
        replyTo: m.message_reference?.message_id ?? null,
        replyToAuthor: m.referenced_message?.author?.username ?? null,
        attachments: atts.length,
        attachmentUrls,
        imageUrls,
        attachmentsDetailed: detailed,
        threadId: m.thread?.id ?? null,
    };
}

function snowflakeToTs(snowflake: string): number {
    try { return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH); } catch { return Number(DISCORD_EPOCH); }
}
function tsToSnowflake(ts: number): string {
    return ((BigInt(Math.floor(ts)) - DISCORD_EPOCH) << 22n).toString();
}

async function restGetWithRetry(query: Record<string, unknown>, channelId: string, attempt = 0): Promise<any> {
    try {
        return await RestAPI.get({ url: Constants.Endpoints.MESSAGES(channelId), query });
    } catch (e: any) {
        const msg = String(e?.message ?? e);
        const isRateLimit = e?.status === 429 || msg.includes("429") || msg.includes("rate");
        if (isRateLimit && attempt < 5) {
            const wait = 1000 * Math.pow(2, attempt) + Math.random() * 500;
            console.warn(`[FetchChannelMessages] 429 rate limited, retry ${attempt + 1} in ${Math.round(wait)}ms`);
            await new Promise(r => setTimeout(r, wait));
            return restGetWithRetry(query, channelId, attempt + 1);
        }
        throw e;
    }
}

// auto-save without popup: tries native fs -> ~/Downloads, falls back to anchor download
async function downloadJsonAuto(data: unknown, filename: string) {
    const json = JSON.stringify(data, null, 2);
    // try Vencord native helper first (no dialog)
    try {
        const Native: any = (window as any).VencordNative?.pluginHelpers?.FetchChannelMessages;
        if (Native?.saveJson) {
            const saved = await Native.saveJson(filename, json);
            console.log(`[FetchChannelMessages] auto-saved ${saved}`);
            return;
        }
    } catch (e) { console.warn("[FCM] native save failed, fallback", e); }

    // try direct Node fs if exposed (some Electron configs)
    try {
        const fs: any = (window as any).require?.("fs");
        const path: any = (window as any).require?.("path");
        const os: any = (window as any).require?.("os");
        if (fs?.writeFileSync && path && os) {
            const filePath = path.join(os.homedir(), "Downloads", filename);
            fs.writeFileSync(filePath, json, "utf-8");
            console.log(`[FCM] auto-saved ${filePath}`);
            return;
        }
    } catch {}

    // fallback: anchor click (may show save dialog if user has "Ask where to save" on)
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// resume helpers
function resumeKey(channelId: string) { return `fcm-resume-${channelId}`; }
function loadResume(channelId: string): { baseName: string; part: number; total: number; before?: string } | null {
    try {
        const raw = localStorage.getItem(resumeKey(channelId));
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}
function saveResume(channelId: string, data: { baseName: string; part: number; total: number; before?: string }) {
    try { localStorage.setItem(resumeKey(channelId), JSON.stringify(data)); } catch {}
}
function clearResume(channelId: string) {
    try { localStorage.removeItem(resumeKey(channelId)); } catch {}
}

// true streaming + parallel + resume + auto-save
async function doExportLargeChannel(channelId: string, channelName: string | undefined, onProgress: (n: number) => void, signal?: AbortSignal) {
    const channelTs = snowflakeToTs(channelId);
    const now = Date.now();
    const span = Math.max(1, now - channelTs);
    const segDuration = span / PARALLELISM;

    let buffer: ExportRow[] = [];
    let total = 0;
    let part = 1;
    let baseName = `${channelName ?? channelId}-${Date.now()}`;
    let beforeResume: string | undefined;

    // check for resume
    const prev = loadResume(channelId);
    if (prev && prev.baseName && prev.total > 0) {
        const resume = confirm(`Found incomplete export for this channel: ${prev.total} msgs, ${prev.part - 1} parts done (${prev.baseName}). Resume from part ${prev.part}? OK=Resume, Cancel=Start fresh`);
        if (resume) {
            baseName = prev.baseName;
            part = prev.part;
            total = prev.total;
            beforeResume = prev.before;
            onProgress(total);
            console.log(`[FCM] resuming ${channelId} from part ${part} total ${total} before=${beforeResume}`);
        } else {
            clearResume(channelId);
        }
    }

    const flushIfNeeded = async (force = false) => {
        while (buffer.length >= CHUNK_SIZE || (force && buffer.length > 0)) {
            const take = Math.min(CHUNK_SIZE, buffer.length);
            const chunk = buffer.splice(0, take);
            chunk.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
            const filename = total > CHUNK_SIZE || part > 1
                ? `${baseName}-part${String(part).padStart(3, "0")}.json`
                : `${baseName}.json`;
            await downloadJsonAuto(chunk, filename);
            // persist resume after successful flush
            const lastId = chunk[chunk.length - 1]?.id;
            saveResume(channelId, { baseName, part: part + 1, total, before: lastId });
            part++;
            await new Promise(r => setTimeout(r, 30));
        }
    };

    const fetchSegment = async (afterId: string, beforeId: string) => {
        let before: string | undefined = beforeResume ?? beforeId;
        // if resuming, only the segment containing beforeResume should start there, others start at their own before
        // for simplicity, if resuming we let all segments start normally but will filter duplicates via total tracking
        // better: only first segment uses beforeResume, others use their own before
        if (beforeResume && afterId !== tsToSnowflake(channelTs)) {
            before = beforeId;
        }
        const afterBig = BigInt(afterId);
        while (true) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const query: Record<string, unknown> = { limit: PAGE_SIZE };
            if (before) query.before = before;

            const result: any = await restGetWithRetry(query, channelId);
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const batch: DiscordMessage[] = result?.body ?? result;
            if (!Array.isArray(batch)) throw new Error("Unexpected response: " + JSON.stringify(result).slice(0, 500));
            if (batch.length === 0) break;

            const filtered = batch.filter(m => { try { const id = BigInt(m.id); return id > afterBig && id < BigInt(beforeId); } catch { return true; } });
            const hasInWindow = filtered.length > 0;
            for (const m of filtered) buffer.push(toExportRow(m));
            if (hasInWindow) {
                total += filtered.length;
                onProgress(total);
                await flushIfNeeded(false);
            }

            const oldest = batch[batch.length - 1]?.id;
            if (!oldest) break;
            try { if (BigInt(oldest) <= afterBig) break; } catch {}
            before = oldest;
            // save resume cursor periodically
            if (total % 10000 === 0) saveResume(channelId, { baseName, part, total, before });
            if (batch.length < PAGE_SIZE) break;
            await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
        }
    };

    if (span < 7 * 24 * 60 * 60 * 1000) {
        await fetchSegment(tsToSnowflake(channelTs), tsToSnowflake(now + 60000));
    } else {
        const segments: { after: string; before: string }[] = [];
        for (let i = 0; i < PARALLELISM; i++) {
            const start = channelTs + i * segDuration;
            const end = start + segDuration;
            segments.push({ after: tsToSnowflake(start), before: tsToSnowflake(i === PARALLELISM - 1 ? now + 60000 : end) });
        }
        await Promise.all(segments.map(s => fetchSegment(s.after, s.before)));
    }

    await flushIfNeeded(true);
    clearResume(channelId);
    return total;
}

let liveUnsub: (() => void) | null = null;
let currentLiveChannelId: string | null = null;
const liveLog: ExportRow[] = [];
const MAX_LIVE_LOG = 10000;
let barObserver: MutationObserver | null = null;
let injectScheduled = false;

const activeExports = new Map<string, AbortController>();
declare global { interface Window { __FCM_abort?: (id: string) => void; __FCM_active?: Map<string, AbortController>; } }
if (typeof window !== "undefined") {
    (window as any).__FCM_active = activeExports;
    (window as any).__FCM_abort = (id: string) => activeExports.get(id)?.abort();
}

async function doExport() {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return alert("Open a channel first");

    if (activeExports.has(channelId)) {
        activeExports.get(channelId)!.abort();
        return;
    }

    const btn = document.getElementById("fcm-export-btn") as HTMLButtonElement | null;
    if (btn) btn.title = "Click again on same channel to cancel";

    const controller = new AbortController();
    activeExports.set(channelId, controller);
    if (btn) {
        (btn as HTMLButtonElement).disabled = false;
        btn.style.opacity = "1";
        btn.textContent = `⏳ 0`;
    }

    const channel = ChannelStore.getChannel(channelId);
    try {
        const total = await doExportLargeChannel(channelId, channel?.name, n => {
            if (btn && SelectedChannelStore.getChannelId() === channelId) btn.textContent = `⏳ ${n}`;
        }, controller.signal);

        if (controller.signal.aborted) {
            console.log(`[FetchChannelMessages] aborted ${channelId} after ${total} msgs`);
            return;
        }
        if (total === 0) return alert("No messages (empty channel or no permission)");
        console.log(`[FetchChannelMessages] done total=${total} - check ~/Downloads`);
    } catch (e: unknown) {
        if ((e as any)?.name === "AbortError" || controller.signal.aborted) {
            console.log(`[FetchChannelMessages] cancelled ${channelId}`);
            return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[FetchChannelMessages] export failed:", e);
        alert("Export failed: " + msg);
    } finally {
        activeExports.delete(channelId);
        if (SelectedChannelStore.getChannelId() === channelId && btn) {
            btn.textContent = "⬇ Export";
            btn.title = "";
        }
    }
}

async function toggleLive() {
    const { FluxDispatcher } = await import("@webpack/common");
    const btn = document.getElementById("fcm-live-btn") as HTMLButtonElement | null;

    if (liveUnsub) {
        const saveChannelId = currentLiveChannelId ?? SelectedChannelStore.getChannelId() ?? "unknown";
        liveUnsub();
        liveUnsub = null;
        currentLiveChannelId = null;
        if (btn) {
            btn.textContent = "● Live";
            btn.style.background = "#23a559";
        }
        await downloadJsonAuto(liveLog, `live-${saveChannelId}-${Date.now()}.json`);
        return;
    }

    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return alert("Open a channel first");

    currentLiveChannelId = channelId;
    liveLog.length = 0;

    const handler = (e: any) => {
        if (e.message?.channel_id !== currentLiveChannelId) return;
        if (liveLog.length >= MAX_LIVE_LOG) return;
        const m = e.message as DiscordMessage;
        liveLog.push(toExportRow(m));
        if (btn) btn.textContent = `■ Live (${liveLog.length})`;
    };

    FluxDispatcher.subscribe("MESSAGE_CREATE", handler);
    liveUnsub = () => FluxDispatcher.unsubscribe("MESSAGE_CREATE", handler);

    if (btn) {
        btn.textContent = "■ Live (0)";
        btn.style.background = "#da373c";
    }
}

function injectBarButtons() {
    const existing = document.getElementById("fcm-bar");
    if (existing) {
        const liveBtn = document.getElementById("fcm-live-btn") as HTMLButtonElement | null;
        if (liveBtn) {
            if (liveUnsub && currentLiveChannelId) {
                liveBtn.textContent = `■ Live (${liveLog.length})`;
                liveBtn.style.background = "#da373c";
            } else {
                liveBtn.textContent = "● Live";
                liveBtn.style.background = "#23a559";
            }
        }
        return;
    }

    const bar = document.querySelector(BAR_SELECTOR) as HTMLElement | null;
    if (!bar) return;
    const parent = bar.parentElement;
    if (!parent) return;

    const container = document.createElement("div");
    container.id = "fcm-bar";
    container.style.cssText = [
        "display:flex",
        "flex-direction:column",
        "gap:4px",
        "align-items:stretch",
        "padding:0",
        "margin:0 8px 0 0",
        "background:transparent",
        "border:0",
        "flex-shrink:0",
        "z-index:10",
    ].join(";");

    const btnBase = [
        "padding:3px 8px",
        "border-radius:5px",
        "border:0",
        "color:white",
        "font-weight:600",
        "font-size:11px",
        "line-height:14px",
        "cursor:pointer",
        "pointer-events:auto",
        "min-width:56px",
    ].join(";");

    container.innerHTML =
        `<button id="fcm-export-btn" style="${btnBase};background:#5865F2">⬇ Export</button>` +
        `<button id="fcm-live-btn" style="${btnBase};background:${liveUnsub ? "#da373c" : "#23a559"}">${liveUnsub ? `■ Live (${liveLog.length})` : "● Live"}</button>`;

    parent.insertBefore(container, bar);

    container.querySelector("#fcm-export-btn")!.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        doExport();
    });
    container.querySelector("#fcm-live-btn")!.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        toggleLive();
    });
}

function scheduleInject() {
    if (injectScheduled) return;
    injectScheduled = true;
    requestAnimationFrame(() => {
        injectScheduled = false;
        injectBarButtons();
    });
}

export default definePlugin({
    name: "FetchChannelMessages",
    description: "Export every message in current channel with reply chains + live capture (buttons in chat bar)",
    authors: [{ name: "you", id: 0n }],

    start() {
        injectBarButtons();
        barObserver = new MutationObserver(scheduleInject);
        barObserver.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        barObserver?.disconnect();
        barObserver = null;
        injectScheduled = false;
        document.getElementById("fcm-bar")?.remove();
        if (liveUnsub) {
            liveUnsub();
            liveUnsub = null;
            currentLiveChannelId = null;
        }
    },

    toolboxActions: {
        "Export Channel JSON": doExport,
        "Toggle Live Capture": toggleLive,
    },
});
