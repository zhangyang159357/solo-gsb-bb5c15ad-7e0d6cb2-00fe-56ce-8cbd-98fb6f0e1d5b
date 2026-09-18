/**
 * 静态主机地址编排：为子网内的主机逐行分配 IPv4 地址。
 *
 * 输入逐行书写：`主机名 IPv4地址|auto`
 *  - 指定地址：先整体预留全部合法指定地址——须落在子网可用主机范围内且互不重复；
 *  - auto：按输入顺序安置到当前最低可用主机地址，避开全部指定地址（含后续行）、
 *    已安置的 auto 地址，以及 /0～/30 的网络与广播地址；/31、/32 沿用可用主机规则。
 *
 * 逐行给出安置地址或失败原因；任一行非法或空间不足时整体不可导出。
 * 纯本地计算，不修改规划、不产生历史记录。
 */
import { Cidr, cidrToString, ipv4ToLong, lastAddr, longToIpv4 } from './ip';
import { usableRangeOf } from './dhcp';

export type HostLineStatus = 'ok' | 'invalid' | 'nospace';

export interface HostPlanLine {
  /** 物理行号（从 1 开始，空行也计入） */
  row: number;
  /** 主机名；行格式非法时为空串 */
  hostname: string;
  /** 规范化后的请求：'auto' 或 IPv4 字符串；地址非法时为原始输入 */
  request: string;
  isAuto: boolean;
  status: HostLineStatus;
  /** 安置结果（uint32）；失败时为 null */
  addr: number | null;
  /** 失败原因（不含行号） */
  reason?: string;
}

export interface HostPlan {
  lines: HostPlanLine[];
  /** 全部填写行均成功安置时为 true（空输入为 true，是否可导出由调用方另行判断） */
  ok: boolean;
}

/**
 * 主机名校验：点分隔的标签序列，标签 1-63 字符（字母数字加连字符，
 * 不得以连字符开头/结尾），全长 ≤ 253。
 */
export function isValidHostname(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  return name
    .split('.')
    .every((label) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

/**
 * 编排计算：
 *  1. 逐行解析格式、主机名与地址（指定地址须在子网可用主机范围内）；
 *  2. 跨行查重：主机名（大小写不敏感）与指定地址均不得重复；
 *  3. 整体预留全部合法指定地址后，按输入顺序把 auto 安置到最低可用主机地址。
 */
export function planHosts(subnet: Cidr, text: string): HostPlan {
  const usable = usableRangeOf(subnet);
  const lines: HostPlanLine[] = [];

  text.split('\n').forEach((raw, i) => {
    const row = i + 1;
    const t = raw.trim();
    if (!t) return; // 完全空白的行忽略
    const tokens = t.split(/\s+/);
    if (tokens.length !== 2) {
      lines.push({
        row,
        hostname: '',
        request: t,
        isAuto: false,
        status: 'invalid',
        addr: null,
        reason: '格式应为「主机名 IPv4地址|auto」，每行一条',
      });
      return;
    }
    const [hostname, addrToken] = tokens;
    if (!isValidHostname(hostname)) {
      lines.push({
        row,
        hostname,
        request: addrToken,
        isAuto: false,
        status: 'invalid',
        addr: null,
        reason: `主机名非法：${hostname}`,
      });
      return;
    }
    if (addrToken.toLowerCase() === 'auto') {
      lines.push({ row, hostname, request: 'auto', isAuto: true, status: 'ok', addr: null });
      return;
    }
    const addr = ipv4ToLong(addrToken);
    if (addr === null) {
      lines.push({
        row,
        hostname,
        request: addrToken,
        isAuto: false,
        status: 'invalid',
        addr: null,
        reason: `地址必须是 IPv4 或 auto：${addrToken}`,
      });
      return;
    }
    const request = longToIpv4(addr);
    if (addr < subnet.base || addr > lastAddr(subnet)) {
      lines.push({
        row,
        hostname,
        request,
        isAuto: false,
        status: 'invalid',
        addr: null,
        reason: `${request} 越界：不在子网 ${cidrToString(subnet)} 内`,
      });
      return;
    }
    if (addr < usable.start || addr > usable.end) {
      const which = addr === subnet.base ? '网络地址' : '广播地址';
      lines.push({
        row,
        hostname,
        request,
        isAuto: false,
        status: 'invalid',
        addr: null,
        reason: `${request} 是子网 ${cidrToString(subnet)} 的${which}，不可分配给主机`,
      });
      return;
    }
    lines.push({ row, hostname, request, isAuto: false, status: 'ok', addr });
  });

  // 跨行查重：主机名（大小写不敏感）、指定地址；非法行不参与查重
  const seenNames = new Map<string, number>();
  const seenAddrs = new Map<number, number>();
  for (const line of lines) {
    if (line.status !== 'ok') continue;
    const nameKey = line.hostname.toLowerCase();
    const firstName = seenNames.get(nameKey);
    if (firstName !== undefined) {
      line.status = 'invalid';
      line.reason = `主机名与第 ${firstName} 行重复：${line.hostname}`;
      continue;
    }
    seenNames.set(nameKey, line.row);
    if (!line.isAuto && line.addr !== null) {
      const firstAddr = seenAddrs.get(line.addr);
      if (firstAddr !== undefined) {
        line.status = 'invalid';
        line.addr = null;
        line.reason = `指定地址与第 ${firstAddr} 行重复：${line.request}`;
        continue;
      }
      seenAddrs.set(line.addr, line.row);
    }
  }

  // 先整体预留全部合法指定地址，再按输入顺序安置 auto。
  // 指定地址（含后续行）已全部占位，auto 安置位置单调递增，游标无需回退。
  const occupied = new Set<number>();
  for (const line of lines) {
    if (line.status === 'ok' && !line.isAuto && line.addr !== null) occupied.add(line.addr);
  }
  let cursor = usable.start;
  for (const line of lines) {
    if (line.status !== 'ok' || !line.isAuto) continue;
    while (cursor <= usable.end && occupied.has(cursor)) cursor++;
    if (cursor > usable.end) {
      line.status = 'nospace';
      line.reason = `地址空间不足：子网 ${cidrToString(subnet)} 的可用主机地址已耗尽`;
      continue;
    }
    occupied.add(cursor);
    line.addr = cursor;
  }

  return { lines, ok: lines.every((l) => l.status === 'ok') };
}

/** 生成 hosts 文本：全部行按地址数值升序输出「地址 主机名」。仅应在 plan.ok 时调用。 */
export function formatHostsText(plan: HostPlan): string {
  return plan.lines
    .filter((l) => l.status === 'ok' && l.addr !== null)
    .sort((a, b) => (a.addr as number) - (b.addr as number))
    .map((l) => `${longToIpv4(l.addr as number)} ${l.hostname}`)
    .join('\n');
}
