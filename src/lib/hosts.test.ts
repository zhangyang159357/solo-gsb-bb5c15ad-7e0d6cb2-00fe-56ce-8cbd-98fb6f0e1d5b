import { describe, expect, it } from 'vitest';
import { longToIpv4, parseCidr } from './ip';
import { HostPlanLine, formatHostsText, isValidHostname, planHosts } from './hosts';

const cidr = (s: string) => parseCidr(s)!;
const ip = (l: HostPlanLine) => (l.addr === null ? null : longToIpv4(l.addr));

describe('主机名校验', () => {
  it('接受单标签与点分隔主机名', () => {
    expect(isValidHostname('gateway')).toBe(true);
    expect(isValidHostname('web-1')).toBe(true);
    expect(isValidHostname('db.example.com')).toBe(true);
    expect(isValidHostname('a')).toBe(true);
  });

  it('拒绝非法主机名', () => {
    expect(isValidHostname('')).toBe(false);
    expect(isValidHostname('-web')).toBe(false);
    expect(isValidHostname('web-')).toBe(false);
    expect(isValidHostname('bad_name')).toBe(false);
    expect(isValidHostname('a..b')).toBe(false);
    expect(isValidHostname(`${'a'.repeat(64)}`)).toBe(false);
    expect(isValidHostname(`${'a'.repeat(250)}.bbbb`)).toBe(false);
  });
});

describe('行解析', () => {
  it('完全空白的行忽略，行号按物理行保留', () => {
    const plan = planHosts(cidr('10.0.0.0/24'), '\nweb auto\n  \ndb 10.0.0.9\n');
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[0].row).toBe(2);
    expect(plan.lines[1].row).toBe(4);
    expect(plan.ok).toBe(true);
  });

  it('格式非法：字段数不是两个', () => {
    const plan = planHosts(cidr('10.0.0.0/24'), 'solo\na b c');
    expect(plan.ok).toBe(false);
    expect(plan.lines[0].status).toBe('invalid');
    expect(plan.lines[0].reason).toContain('格式');
    expect(plan.lines[1].status).toBe('invalid');
  });

  it('主机名非法逐行报错', () => {
    const plan = planHosts(cidr('10.0.0.0/24'), 'bad_name auto');
    expect(plan.lines[0].status).toBe('invalid');
    expect(plan.lines[0].reason).toContain('主机名非法');
  });

  it('地址必须是 IPv4 或 auto（auto 大小写不敏感）', () => {
    const bad = planHosts(cidr('10.0.0.0/24'), 'web 10.0.0.256\nweb2 10.0.0.1/32');
    expect(bad.lines.every((l) => l.status === 'invalid')).toBe(true);

    const good = planHosts(cidr('10.0.0.0/24'), 'web AUTO\napp Auto');
    expect(good.ok).toBe(true);
    expect(good.lines.every((l) => l.isAuto && l.request === 'auto')).toBe(true);
  });
});

describe('指定地址校验', () => {
  it('越界地址记为非法', () => {
    const plan = planHosts(cidr('10.0.0.0/24'), 'web 10.0.1.5');
    expect(plan.lines[0].status).toBe('invalid');
    expect(plan.lines[0].reason).toContain('越界');
  });

  it('/0～/30 的网络地址与广播地址不可指定', () => {
    const plan = planHosts(cidr('10.0.0.0/24'), 'net 10.0.0.0\nbcast 10.0.0.255');
    expect(plan.lines[0].status).toBe('invalid');
    expect(plan.lines[0].reason).toContain('网络地址');
    expect(plan.lines[1].status).toBe('invalid');
    expect(plan.lines[1].reason).toContain('广播地址');

    const p30 = planHosts(cidr('10.0.0.0/30'), 'net 10.0.0.0\nbcast 10.0.0.3');
    expect(p30.lines.every((l) => l.status === 'invalid')).toBe(true);
  });

  it('/31、/32 沿用可用主机规则：全部地址可指定', () => {
    const p31 = planHosts(cidr('10.0.0.0/31'), 'a 10.0.0.0\nb 10.0.0.1');
    expect(p31.ok).toBe(true);
    const p32 = planHosts(cidr('10.0.0.7/32'), 'only 10.0.0.7');
    expect(p32.ok).toBe(true);
  });

  it('指定地址重复记为非法（带首次行号）', () => {
    const plan = planHosts(cidr('10.0.0.0/24'), 'a 10.0.0.5\nb 10.0.0.5');
    expect(plan.ok).toBe(false);
    expect(plan.lines[0].status).toBe('ok');
    expect(plan.lines[1].status).toBe('invalid');
    expect(plan.lines[1].reason).toContain('第 1 行');
    expect(plan.lines[1].reason).toContain('重复');
  });

  it('主机名重复（大小写不敏感）记为非法', () => {
    const plan = planHosts(cidr('10.0.0.0/24'), 'Web auto\nweb 10.0.0.9');
    expect(plan.ok).toBe(false);
    expect(plan.lines[1].status).toBe('invalid');
    expect(plan.lines[1].reason).toContain('主机名与第 1 行重复');
  });
});

describe('auto 安置', () => {
  it('按输入顺序安置到最低可用主机地址', () => {
    const plan = planHosts(cidr('10.0.0.0/24'), 'a auto\nb auto\nc auto');
    expect(plan.ok).toBe(true);
    expect(plan.lines.map(ip)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });

  it('避开指定地址与网络/广播地址', () => {
    const plan = planHosts(cidr('10.0.0.0/29'), 'gw 10.0.0.1\na auto\nb auto');
    expect(plan.ok).toBe(true);
    expect(plan.lines.map(ip)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });

  it('前序 auto 不抢占后续行的指定地址', () => {
    // 指定地址整体预留：auto 虽在前，仍须跳过第 3 行指定的 .1
    const plan = planHosts(cidr('10.0.0.0/29'), 'web auto\ndb auto\ngw 10.0.0.1');
    expect(plan.ok).toBe(true);
    expect(plan.lines.map(ip)).toEqual(['10.0.0.2', '10.0.0.3', '10.0.0.1']);
  });

  it('/31 与 /32 的 auto 安置', () => {
    const p31 = planHosts(cidr('10.0.0.0/31'), 'a auto\nb auto');
    expect(p31.ok).toBe(true);
    expect(p31.lines.map(ip)).toEqual(['10.0.0.0', '10.0.0.1']);

    const p32 = planHosts(cidr('10.0.0.7/32'), 'only auto');
    expect(p32.ok).toBe(true);
    expect(ip(p32.lines[0])).toBe('10.0.0.7');
  });

  it('空间不足时记为 nospace 且整体不通过', () => {
    // /30 仅 2 个可用主机地址
    const plan = planHosts(cidr('10.0.0.0/30'), 'a auto\nb auto\nc auto');
    expect(plan.ok).toBe(false);
    expect(plan.lines[0].status).toBe('ok');
    expect(plan.lines[1].status).toBe('ok');
    expect(plan.lines[2].status).toBe('nospace');
    expect(plan.lines[2].reason).toContain('空间不足');
  });

  it('指定地址占满后 auto 空间不足', () => {
    const plan = planHosts(cidr('10.0.0.0/30'), 'a 10.0.0.1\nb 10.0.0.2\nc auto');
    expect(plan.ok).toBe(false);
    expect(plan.lines[2].status).toBe('nospace');
  });

  it('非法行不占用地址，后续 auto 继续安置', () => {
    const plan = planHosts(cidr('10.0.0.0/24'), 'bad_line\nweb auto');
    expect(plan.ok).toBe(false);
    expect(plan.lines[0].status).toBe('invalid');
    expect(plan.lines[1].status).toBe('ok');
    expect(ip(plan.lines[1])).toBe('10.0.0.1');
  });
});

describe('hosts 文本导出', () => {
  it('按地址数值升序输出「地址 主机名」', () => {
    const plan = planHosts(
      cidr('10.0.0.0/24'),
      'db 10.0.0.20\nweb 10.0.0.10\ngw 10.0.0.1\ncache auto',
    );
    expect(plan.ok).toBe(true);
    expect(formatHostsText(plan)).toBe(
      ['10.0.0.1 gw', '10.0.0.2 cache', '10.0.0.10 web', '10.0.0.20 db'].join('\n'),
    );
  });

  it('端到端：混合指定与 auto，auto 穿插预留空隙', () => {
    const plan = planHosts(
      cidr('192.168.1.0/29'),
      'router 192.168.1.1\nnas auto\nprinter 192.168.1.4\npc auto',
    );
    expect(plan.ok).toBe(true);
    expect(plan.lines.map(ip)).toEqual([
      '192.168.1.1',
      '192.168.1.2',
      '192.168.1.4',
      '192.168.1.3',
    ]);
    expect(formatHostsText(plan)).toBe(
      ['192.168.1.1 router', '192.168.1.2 nas', '192.168.1.3 pc', '192.168.1.4 printer'].join(
        '\n',
      ),
    );
  });

  it('空输入不产生任何行', () => {
    const plan = planHosts(cidr('10.0.0.0/24'), '  \n\n');
    expect(plan.lines).toHaveLength(0);
    expect(plan.ok).toBe(true);
    expect(formatHostsText(plan)).toBe('');
  });
});
