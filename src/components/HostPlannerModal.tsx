import { useMemo, useState } from 'react';
import { Allocation } from '../lib/model';
import { cidrToString, longToIpv4, parseCidr } from '../lib/ip';
import { usableRangeOf } from '../lib/dhcp';
import { formatHostsText, planHosts } from '../lib/hosts';

interface Props {
  alloc: Allocation;
  onClose: () => void;
}

const STATUS_LABEL = {
  ok: '已安置',
  invalid: '非法',
  nospace: '空间不足',
} as const;

/**
 * 静态主机地址编排弹窗：逐行填写「主机名 IPv4地址|auto」，
 * 先整体预留全部合法指定地址，再按输入顺序把 auto 安置到最低可用主机地址。
 * 任一行非法或空间不足时禁止导出；全部通过后可复制并下载按地址排序的 hosts 文本。
 * 纯本地计算，不修改规划与历史。
 */
export default function HostPlannerModal({ alloc, onClose }: Props) {
  const subnet = parseCidr(alloc.cidr)!;
  const usable = usableRangeOf(subnet);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);

  const plan = useMemo(() => planHosts(parseCidr(alloc.cidr)!, text), [alloc.cidr, text]);
  const okCount = plan.lines.filter((l) => l.status === 'ok').length;
  /** 任一行非法或空间不足、或没有有效行时禁止导出 */
  const exportable = plan.ok && plan.lines.length > 0;
  const hostsText = exportable ? formatHostsText(plan) : '';

  const copyResult = async () => {
    try {
      await navigator.clipboard.writeText(hostsText);
    } catch {
      // 剪贴板 API 不可用（如非安全上下文）时回退
      const ta = document.createElement('textarea');
      ta.value = hostsText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
  };

  const downloadResult = () => {
    const blob = new Blob([`${hostsText}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hosts-${cidrToString(subnet).replace('/', '_')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>静态主机地址编排：{alloc.name}</h3>
        <p className="muted">
          子网 <code>{alloc.cidr}</code>，可用主机范围{' '}
          <code>
            {longToIpv4(usable.start)} - {longToIpv4(usable.end)}
          </code>
          {subnet.prefix <= 30
            ? '（已排除网络地址与广播地址）'
            : `（/${subnet.prefix} 按可用主机规则不排除任何地址）`}
          。每行填写「主机名 IPv4地址|auto」：指定地址先整体预留，auto 按输入顺序安置到最低可用主机地址，
          避开全部指定地址（含后续行）与已占用地址。任一行非法或空间不足时禁止导出。
          纯本地计算，不修改规划与历史。
        </p>
        <label className="field">
          <span>主机编排（每行一条：主机名 IPv4地址|auto；空行忽略）</span>
          <textarea
            autoFocus
            rows={6}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCopied(false);
            }}
            placeholder={'例如：\ngateway 10.0.0.1\nweb auto\ndb auto'}
            spellCheck={false}
          />
        </label>

        {plan.lines.length > 0 && (
          <>
            <p className="muted">
              已填写 {plan.lines.length} 行 · 已安置 {okCount} 行
              {plan.ok ? '' : ` · ${plan.lines.length - okCount} 行待修正`}
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>主机名</th>
                    <th>请求</th>
                    <th>分配地址</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.lines.map((l) => (
                    <tr
                      key={l.row}
                      className={
                        l.status !== 'ok'
                          ? `mig-${l.status === 'nospace' ? 'failed' : 'moved'}`
                          : undefined
                      }
                    >
                      <td className="muted">{l.row}</td>
                      <td>
                        {l.hostname ? <strong>{l.hostname}</strong> : <span className="muted">—</span>}
                      </td>
                      <td>
                        <code>{l.request}</code>
                      </td>
                      <td>
                        {l.addr !== null ? (
                          <code>{longToIpv4(l.addr)}</code>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {l.status === 'ok' ? (
                          <span className="badge mig-kept">
                            ✓ {l.isAuto ? 'auto 安置' : '指定地址'}
                          </span>
                        ) : (
                          <span
                            className={`badge mig-${l.status === 'nospace' ? 'failed' : 'moved'}`}
                            title={l.reason}
                          >
                            {STATUS_LABEL[l.status]}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {plan.lines.some((l) => l.status !== 'ok') && (
          <ul className="errors">
            {plan.lines
              .filter((l) => l.status !== 'ok')
              .map((l) => (
                <li key={l.row}>
                  第 {l.row} 行{l.hostname ? `（${l.hostname}）` : ''}：{l.reason}
                </li>
              ))}
          </ul>
        )}

        {exportable ? (
          <div className="dhcp-result">
            <div className="dhcp-result-head">
              <span>hosts 文本（按地址升序，共 {plan.lines.length} 行）</span>
              <span className="row-actions inline">
                <button className="btn small" onClick={copyResult}>
                  {copied ? '已复制 ✓' : '复制 hosts 文本'}
                </button>
                <button className="btn small" onClick={downloadResult}>
                  下载 hosts 文件
                </button>
              </span>
            </div>
            <textarea
              readOnly
              rows={Math.min(Math.max(plan.lines.length, 2), 12)}
              value={hostsText}
            />
          </div>
        ) : (
          plan.lines.length > 0 && (
            <p className="muted">存在非法或空间不足的行，全部修正后方可复制与下载 hosts 文本。</p>
          )
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
