/**
 * 码库模块：离线 JSON 码库查询 + Kookong 在线码库 client + 品牌模糊搜索 + 智能匹配
 *
 * - 离线：构建期由 scripts/gen-codelib.mjs 生成 src/assets/codes/codes.json（≥1000 条）
 * - 在线：Kookong API（http://sdk2.kookong.com，逆向报告见 E:/Projects/rehub/红外遥控/analysis/REPORT.md）
 *   结果 localStorage 缓存 24h，所有在线函数 8s 超时，失败降级离线
 */
import Fuse from 'fuse.js';
import codesJson from '../../assets/codes/codes.json';
import type { CodeEntry } from '../../types/ir';

/* ================= 离线码库 ================= */

export interface OfflineLibrary {
  version: string;
  generatedAt: string;
  count: number;
  entries: CodeEntry[];
}

const lib = codesJson as unknown as OfflineLibrary;

/** 离线码库版本（如 "1.0.0"） */
export const CODELIB_VERSION: string = lib.version;

let entriesCache: CodeEntry[] | null = null;

/** 加载离线码库（返回全部条目，模块内缓存） */
export function loadOfflineLibrary(): CodeEntry[] {
  entriesCache ??= lib.entries;
  return entriesCache;
}

export interface BrandInfo {
  name: string;
  aliases: string[];
  deviceTypes: string[];
  entryCount: number;
}

export interface DeviceTypeInfo {
  deviceType: string;
  deviceTypeName: string;
  entryCount: number;
  brandCount: number;
}

let brandsCache: BrandInfo[] | null = null;

/** 离线码库中的品牌列表（含别名与覆盖品类） */
export function listBrands(): BrandInfo[] {
  if (brandsCache) return brandsCache;
  const map = new Map<string, BrandInfo>();
  for (const e of loadOfflineLibrary()) {
    let b = map.get(e.brand);
    if (!b) {
      b = { name: e.brand, aliases: e.brandAliases ?? [], deviceTypes: [], entryCount: 0 };
      map.set(e.brand, b);
    }
    if (!b.deviceTypes.includes(e.deviceType)) b.deviceTypes.push(e.deviceType);
    b.entryCount++;
  }
  brandsCache = [...map.values()];
  return brandsCache;
}

/** 离线码库中的品类列表 */
export function listDeviceTypes(): DeviceTypeInfo[] {
  const map = new Map<string, DeviceTypeInfo>();
  const brandsPerType = new Map<string, Set<string>>();
  for (const e of loadOfflineLibrary()) {
    let d = map.get(e.deviceType);
    if (!d) {
      d = { deviceType: e.deviceType, deviceTypeName: e.deviceTypeName, entryCount: 0, brandCount: 0 };
      map.set(e.deviceType, d);
    }
    d.entryCount++;
    let s = brandsPerType.get(e.deviceType);
    if (!s) brandsPerType.set(e.deviceType, (s = new Set()));
    s.add(e.brand);
  }
  for (const [dt, d] of map) d.brandCount = brandsPerType.get(dt)?.size ?? 0;
  return [...map.values()];
}

let fuse: Fuse<BrandInfo> | null = null;

/** fuse.js 模糊搜索品牌（匹配品牌名与别名），空查询返回全部品牌 */
export function searchBrand(query: string): BrandInfo[] {
  const brands = listBrands();
  const q = query.trim();
  if (!q) return brands;
  fuse ??= new Fuse(brands, {
    keys: [
      { name: 'name', weight: 2 },
      { name: 'aliases', weight: 1 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
  });
  return fuse.search(q).map((r) => r.item);
}

/** 品牌名/别名归一化匹配（大小写不敏感） */
function brandEquals(entry: CodeEntry, brand: string): boolean {
  const b = brand.trim().toLowerCase();
  if (entry.brand.toLowerCase() === b) return true;
  return (entry.brandAliases ?? []).some((a) => a.toLowerCase() === b);
}

/** 取某品牌某品类的全部键码 */
export function getCodes(brand: string, deviceType: string): CodeEntry[] {
  return loadOfflineLibrary().filter((e) => e.deviceType === deviceType && brandEquals(e, brand));
}

/** 取某品牌某品类某按键的单条码，找不到返回 null */
export function findCode(brand: string, deviceType: string, key: string): CodeEntry | null {
  return getCodes(brand, deviceType).find((e) => e.key === key) ?? null;
}

/* ================= Kookong 在线码库 ================= */

export const KOOKONG_BASE = 'http://sdk2.kookong.com';
export const KOOKONG_APPKEY = 'E8A87CE67252443109C61029771A7143';

/** 本库 deviceType → Kookong deviceTypeId（REPORT.md 第 0/4 节：1..15 编号） */
export const KOOKONG_DEVICE_TYPE: Record<string, number> = {
  stb: 1, tv: 2, box: 3, dvd: 4, ac: 5, projector: 6, amp: 7, fan: 8,
  light: 10, air: 11, speaker: 7, // Kookong 无独立音响品类，归入功放
};

const CACHE_TTL_MS = 24 * 3600 * 1000;
const ONLINE_TIMEOUT_MS = 8000;
const CACHE_PREFIX = 'kookong:';

/** 在线开关（Settings 页可关），默认开 */
export let onlineEnabled = true;
export function setOnlineEnabled(v: boolean): void {
  onlineEnabled = v;
}

interface CacheBox<T> {
  t: number;
  data: T;
}

function storageGet<T>(key: string): T | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const box = JSON.parse(raw) as CacheBox<T>;
    if (Date.now() - box.t > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return box.data;
  } catch {
    return null;
  }
}

function storageSet(key: string, data: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const box: CacheBox<unknown> = { t: Date.now(), data };
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(box));
  } catch {
    /* 缓存写失败忽略（如隐私模式） */
  }
}

/** 清空全部 Kookong 缓存 */
export function clearOnlineCache(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

export class KookongError extends Error {
  constructor(
    message: string,
    public readonly url?: string,
  ) {
    super(message);
    this.name = 'KookongError';
  }
}

/** 带 8s 超时 + 24h localStorage 缓存的 GET；返回 Kookong 包裹里的 content（自动 JSON.parse） */
async function kookongGet<T = unknown>(path: string, params: Record<string, string | number>): Promise<T> {
  const qs = new URLSearchParams({ appkey: KOOKONG_APPKEY });
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const url = `${KOOKONG_BASE}${path}?${qs.toString()}`;

  const cached = storageGet<T>(url);
  if (cached !== null) return cached;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ONLINE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new KookongError(`HTTP ${resp.status}`, url);
    const body = (await resp.json()) as { errno?: string | number; content?: unknown };
    if (body.errno !== undefined && String(body.errno) !== '0') {
      throw new KookongError(`Kookong errno=${String(body.errno)}`, url);
    }
    let content = body.content as unknown;
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch {
        /* content 本来就是纯文本 */
      }
    }
    const data = (content ?? body) as T;
    storageSet(url, data);
    return data;
  } catch (err) {
    if (err instanceof KookongError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new KookongError(`请求超时（>${ONLINE_TIMEOUT_MS}ms）`, url);
    }
    throw new KookongError(err instanceof Error ? err.message : String(err), url);
  } finally {
    clearTimeout(timer);
  }
}

export interface KookongBrand {
  bid: number;
  name: string;
  /** 来自离线降级时为 true */
  offline?: boolean;
}

export interface KookongRemoteList {
  rids: number[];
  raw?: unknown;
}

export interface KookongIrOptions {
  /** 0/1，1 = 测试码 */
  mcode?: 0 | 1;
  /** 0/1/3，1 = 单按键压缩，3 = repeatCodeFormat */
  alg?: 0 | 1 | 3;
  /** 0/1，是否返回按键 */
  ackey?: 0 | 1;
  /** 0/1，返回按键组 */
  keyGroup?: 0 | 1;
  /** 0/1，AC 扩展 */
  acext?: 0 | 1;
}

/**
 * 在线拉取品牌列表；失败（离线/超时/errno）时降级为离线码库品牌。
 * GET /m/brands?deviceType=…&countryCode=…
 */
export async function getBrands(deviceType: string, countryCode = 'CN'): Promise<KookongBrand[]> {
  const did = KOOKONG_DEVICE_TYPE[deviceType] ?? 2;
  if (onlineEnabled) {
    try {
      const data = await kookongGet<{ brandList?: Array<{ bid?: number; id?: number; name: string }> }>(
        '/m/brands',
        { deviceType: did, countryCode },
      );
      const list = data?.brandList ?? (Array.isArray(data) ? (data as Array<{ bid?: number; id?: number; name: string }>) : []);
      return list.map((b) => ({ bid: b.bid ?? b.id ?? -1, name: b.name }));
    } catch {
      /* 降级离线 */
    }
  }
  return listBrands()
    .filter((b) => b.deviceTypes.includes(deviceType))
    .map((b) => ({ bid: -1, name: b.name, offline: true }));
}

/**
 * 在线拉取遥控器 ID 列表；失败返回 null（由调用方决定是否回退离线码库）。
 * GET /m/remotes?did=…&bid=…&spId=…&areaId=…&countryCode=…
 */
export async function getRemotes(
  did: number,
  bid: number,
  spId = 0,
  areaId = 0,
  countryCode = 'CN',
): Promise<KookongRemoteList | null> {
  if (!onlineEnabled) return null;
  try {
    const data = await kookongGet<{ rids?: number[]; remoteIds?: number[] }>('/m/remotes', {
      did, bid, spId, areaId, countryCode,
    });
    const rids = data?.rids ?? data?.remoteIds ?? [];
    return { rids, raw: data };
  } catch {
    return null;
  }
}

/**
 * 在线下载红外码；失败返回 null。
 * GET /m/irs?rids=…&bid=…&mcode=…&alg=…&ackey=…
 */
export async function getIrData(
  rids: number[],
  bid: number,
  opts: KookongIrOptions = {},
): Promise<unknown | null> {
  if (!onlineEnabled || rids.length === 0) return null;
  try {
    return await kookongGet('/m/irs', {
      rids: rids.join(','),
      bid,
      mcode: opts.mcode ?? 0,
      alg: opts.alg ?? 0,
      ackey: opts.ackey ?? 1,
      keyGroup: opts.keyGroup ?? 0,
      acext: opts.acext ?? 0,
    });
  } catch {
    return null;
  }
}

/* ================= 智能匹配（「有反应」式） ================= */

/** 一个候选遥控器 = 一组同协议同地址的键码 */
export interface MatchCandidate {
  id: string;
  protocol: string;
  address?: number;
  entries: CodeEntry[];
}

/** 把键码按「协议+地址」分组成候选遥控器 */
export function groupCandidates(entries: CodeEntry[]): MatchCandidate[] {
  const map = new Map<string, MatchCandidate>();
  for (const e of entries) {
    const key = `${e.protocol}:${e.address ?? -1}`;
    let c = map.get(key);
    if (!c) {
      c = { id: key, protocol: e.protocol, address: e.address, entries: [] };
      map.set(key, c);
    }
    c.entries.push(e);
  }
  return [...map.values()];
}

const DEFAULT_TEST_KEYS = ['power', 'vol_up', 'ch_up', 'temp_up', 'ok'];

/**
 * SmartMatcher：「有反应」式匹配引擎。
 *
 * 用法：
 * ```ts
 * const m = new SmartMatcher('索尼', 'tv');
 * let test = m.next();            // 取当前候选的测试键码（power 优先）
 * // …发射 test，问用户有没有反应…
 * m.feedback(true);               // 有反应 → 收敛，m.result 为整套键码
 * m.feedback(false);              // 无反应 → 下一候选；next() 耗尽返回 null
 * ```
 *
 * 默认候选来自离线码库（按协议+地址分组）；也可传入在线码库整理的候选组。
 */
export class SmartMatcher {
  private candidates: MatchCandidate[];
  private cursor = 0;
  private matched: MatchCandidate | null = null;
  private readonly testKeys: string[];
  readonly brand: string;
  readonly deviceType: string;

  constructor(
    brand: string,
    deviceType: string,
    candidates?: MatchCandidate[],
    testKeys: string[] = DEFAULT_TEST_KEYS,
  ) {
    this.brand = brand;
    this.deviceType = deviceType;
    this.candidates = candidates ?? groupCandidates(getCodes(brand, deviceType));
    this.testKeys = testKeys;
  }

  /** 总候选数 */
  get total(): number {
    return this.candidates.length;
  }

  /** 当前候选序号（0 起），已耗尽时为 total */
  get index(): number {
    return this.cursor;
  }

  /** 剩余候选数 */
  get remaining(): number {
    return Math.max(0, this.candidates.length - this.cursor);
  }

  /** 是否已收敛 */
  get done(): boolean {
    return this.matched !== null;
  }

  /** 匹配成功后的整套键码；未收敛为 null */
  get result(): CodeEntry[] | null {
    return this.matched?.entries ?? null;
  }

  /** 当前候选（未推进、未收敛时） */
  get currentCandidate(): MatchCandidate | null {
    if (this.matched) return this.matched;
    return this.candidates[this.cursor] ?? null;
  }

  /**
   * 取当前候选遥控器的测试键码（按 testKeys 顺序，power 优先）。
   * 候选耗尽或已收敛时返回 null。
   */
  next(): CodeEntry | null {
    if (this.matched) return null;
    while (this.cursor < this.candidates.length) {
      const cand = this.candidates[this.cursor];
      for (const k of this.testKeys) {
        const e = cand.entries.find((x) => x.key === k);
        if (e) return e;
      }
      this.cursor++; // 该候选没有任何测试键，跳过
    }
    return null;
  }

  /**
   * 用户反馈当前测试键码是否有反应。
   * worked=true  → 收敛，result 可用；
   * worked=false → 推进到下一候选（之后调用 next() 继续）。
   */
  feedback(worked: boolean): void {
    if (this.matched) return;
    if (worked) {
      this.matched = this.candidates[this.cursor] ?? null;
    } else {
      this.cursor++;
    }
  }

  /** 重置匹配过程 */
  reset(): void {
    this.cursor = 0;
    this.matched = null;
  }
}
