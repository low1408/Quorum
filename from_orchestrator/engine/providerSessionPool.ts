import type { Browser, BrowserContext, Page } from 'playwright';

export interface SessionPoolItem {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  hasActiveThread: boolean;
  isCdp?: boolean;
  ownsBrowser?: boolean;
  ownsContext?: boolean;
  ownsPage?: boolean;
  providerId?: string;
  createdAt?: number;
  lastUsedAt?: number;
  invalidated?: boolean;
}

export function newPoolItem(providerId?: string): SessionPoolItem {
  const now = Date.now();
  return {
    browser: null,
    context: null,
    page: null,
    hasActiveThread: false,
    providerId,
    createdAt: now,
    lastUsedAt: now
  };
}

export class ProviderSessionPool {
  private readonly items = new Map<string, SessionPoolItem>();
  private closing = false;

  public acquire(providerId: string): SessionPoolItem {
    const existing = this.items.get(providerId);
    if (existing && !existing.invalidated) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const item = newPoolItem(providerId);
    this.items.set(providerId, item);
    return item;
  }

  public get(providerId: string): SessionPoolItem | undefined {
    return this.items.get(providerId);
  }

  public entries(): Array<[string, SessionPoolItem]> {
    return Array.from(this.items.entries());
  }

  public async invalidate(providerId: string, reason: string): Promise<void> {
    const item = this.items.get(providerId);
    if (!item) return;
    item.invalidated = true;
    this.items.delete(providerId);
    await closeSessionItem(item, reason);
  }

  public async closeAll(reason = 'pool shutdown'): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const entries = this.entries();
    this.items.clear();

    const errors: string[] = [];
    for (const [, item] of entries) {
      try {
        item.invalidated = true;
        await closeSessionItem(item, reason);
      } catch (err: any) {
        errors.push(err?.message || String(err));
      }
    }

    this.closing = false;
    if (errors.length > 0) {
      throw new Error(`Session cleanup failed: ${errors.join('; ')}`);
    }
  }
}

export async function closeSessionItem(item: SessionPoolItem, reason = 'cleanup'): Promise<void> {
  const page = item.page;
  const context = item.context;
  const browser = item.browser;
  const isCdp = !!item.isCdp;
  const ownsBrowser = item.ownsBrowser !== false && !isCdp;
  const ownsContext = item.ownsContext !== false;
  const ownsPage = item.ownsPage !== false;

  item.page = null;
  item.context = null;
  item.browser = null;
  item.hasActiveThread = false;

  if (page && ownsPage) {
    console.log(`[KEEP-ALIVE] Keeping page open (requested close reason: ${reason})`);
  }

  if (context && ownsContext) {
    console.log(`[KEEP-ALIVE] Keeping context open (requested close reason: ${reason})`);
  }

  if (browser && ownsBrowser) {
    console.log(`[KEEP-ALIVE] Keeping browser open (requested close reason: ${reason})`);
  }
}
