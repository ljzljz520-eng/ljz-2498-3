// 渲染服务：把导出视图模型渲染为正式纪要 HTML
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const STATUS_LABEL = { open: '进行中', done: '已完成', cancelled: '已取消' };

function taskLine(t) {
  const owner = t.owner ? esc(t.owner) : '<span class="missing">未指派</span>';
  const ack = t.owner ? (t.acked ? '已签收' : '未签收') : '—';
  const res = t.resolution_code
    ? `决议 ${esc(t.resolution_code)}${t.resolution_status === 'withdrawn' ? '（已撤回）' : ''}`
    : '—';
  return { owner, ack, res };
}

export function renderMinutes(model) {
  const { meeting, version, content, resolutions, tasks, blocks, generated_at } = model;
  const agendaHtml = (content.agenda || []).length
    ? `<ol>${content.agenda.map(a => `<li>${esc(a.title)}</li>`).join('')}</ol>`
    : '<p class="muted">（无议题）</p>';

  const blocksHtml = blocks.map(b => {
    if (b.type === 'paragraph') return `<p>${esc(b.text)}</p>`;
    if (b.type === 'resolution') {
      const r = b.resolution;
      const tag = r && r.status_at_version === 'withdrawn' ? '<span class="withdrawn">（已撤回）</span>' : '';
      const code = r ? esc(r.code) : '?';
      return `<div class="resolution"><strong>决议 ${code}</strong>：${esc(b.text)} ${tag}</div>`;
    }
    if (b.type === 'todo') {
      if (!b.task) return `<div class="todo">【待办】${esc(b.title)} <span class="muted">（任务实体缺失）</span></div>`;
      const t = b.task;
      const info = taskLine(t);
      return `<div class="todo">【待办 ${esc(t.code)}】${esc(t.title)} ｜ 负责人：${info.owner} ｜ 截止：${esc(t.due_label)} ｜ 状态：${STATUS_LABEL[t.status] || t.status}</div>`;
    }
    return '';
  }).join('\n');

  const resRows = resolutions.map(r =>
    `<tr><td>${esc(r.code)}</td><td>${esc(r.text)}</td><td>${r.status_at_version === 'withdrawn' ? '已撤回' : '生效中'}</td></tr>`
  ).join('');

  const taskRows = tasks.map(t => {
    const info = taskLine(t);
    return `<tr>
      <td>${esc(t.code)}</td><td>${esc(t.title)}</td><td>${info.owner}</td><td>${info.ack}</td>
      <td>${esc(t.due_label)}</td><td>${STATUS_LABEL[t.status] || t.status}</td>
      <td>${info.res}</td><td>${t.mention_blocks.length}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>会议纪要 - ${esc(meeting.title)}</title>
<style>
  body { font-family: "Songti SC", "SimSun", serif; max-width: 880px; margin: 2em auto; color: #222; line-height: 1.7; }
  h1 { text-align: center; } h2 { border-bottom: 2px solid #444; padding-bottom: 4px; margin-top: 1.6em; }
  table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #888; padding: 6px 8px; font-size: 14px; }
  th { background: #f0f0f0; }
  .meta td { border: none; padding: 2px 8px; }
  .resolution { background: #f7f7f0; border-left: 4px solid #8a6d3b; padding: 8px 12px; margin: 8px 0; }
  .todo { background: #f0f6ff; border-left: 4px solid #2f6fbc; padding: 8px 12px; margin: 8px 0; }
  .missing { color: #b00; font-weight: bold; } .withdrawn { color: #b00; } .muted { color: #888; }
  footer { margin-top: 2em; color: #666; font-size: 13px; border-top: 1px solid #ccc; padding-top: 8px; }
</style></head><body>
<h1>会 议 纪 要</h1>
<table class="meta">
  <tr><td><strong>会议名称</strong></td><td>${esc(meeting.title)}</td>
      <td><strong>纪要版本</strong></td><td>第 ${version.version_no} 版（${version.kind === 'finalize' ? '定稿' : '草稿'}）</td></tr>
  <tr><td><strong>定稿时间</strong></td><td>${version.kind === 'finalize' ? esc(version.created_at) : '未定稿'}</td>
      <td><strong>导出时间</strong></td><td>${esc(generated_at)}</td></tr>
</table>
<h2>一、议题</h2>
${agendaHtml}
<h2>二、会议内容</h2>
${blocksHtml}
<h2>三、决议清单</h2>
${resRows ? `<table><thead><tr><th>编号</th><th>决议内容</th><th>状态</th></tr></thead><tbody>${resRows}</tbody></table>` : '<p class="muted">（无决议）</p>'}
<h2>四、待办事项汇总表</h2>
${taskRows ? `<table><thead><tr><th>编号</th><th>事项</th><th>负责人</th><th>签收</th><th>截止时间</th><th>状态</th><th>关联决议</th><th>正文引用数</th></tr></thead><tbody>${taskRows}</tbody></table>` : '<p class="muted">（无待办事项）</p>'}
<footer>
  本纪要由渲染服务依据第 ${version.version_no} 版${version.kind === 'finalize' ? '定稿快照' : '时点数据'}生成；
  负责人、签收与任务状态均为该时点记录，不反映其后的变更。
</footer>
</body></html>`;
}
