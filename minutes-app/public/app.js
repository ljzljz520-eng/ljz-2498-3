/* global Vue */
const { createApp } = Vue;

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxx-4xxx-yxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }) + '-' + Date.now().toString(16));

/* ---- 时区换算（与服务端一致的语义） ---- */
function tzOffsetMs(tz, utcDate) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(utcDate).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcDate.getTime();
}
function zonedLocalToUtcIso(local, tz) { // 'YYYY-MM-DDTHH:mm' in tz -> UTC ISO
  const [d, t] = local.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, dd, hh, mm, 0);
  for (let i = 0; i < 3; i++) guess = Date.UTC(y, m - 1, dd, hh, mm, 0) - tzOffsetMs(tz, new Date(guess));
  return new Date(guess).toISOString();
}
function utcIsoToZonedLocal(iso, tz) { // UTC ISO -> 'YYYY-MM-DDTHH:mm' in tz
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) { const e = new Error(data?.message || res.statusText); e.status = res.status; e.body = data; throw e; }
  return data;
}

createApp({
  data: () => ({
    meetings: [], currentId: null, state: null,
    meetingTitle: '', agenda: [], blocks: [],
    baseVersionNo: 0, saveToken: null,
    author: localStorage.getItem('minutes-author') || '',
    saving: false, error: null, notice: null, conflict: null,
    finalizeInfo: null, histories: {},
    reassignTask: null, reassignForm: { owner_name: '', ticket: '', reason: '' },
    exportVersionNo: null,
    tzOptions: ['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'],
  }),
  computed: {
    finalized() { return this.state?.meeting.status === 'finalized'; },
    finalizedVersionNo() {
      const v = this.state?.versions.find(x => x.id === this.state.meeting.finalized_version_id);
      return v ? v.version_no : null;
    },
    todoBlockCount() { return this.blocks.filter(b => b.type === 'todo').length; },
    establishedCount() { return this.blocks.filter(b => b.type === 'todo' && this.taskByToken(b.token)).length; },
    taskByToken() {
      const map = new Map((this.state?.tasks || []).map(t => [t.client_token, t]));
      return (token) => map.get(token);
    },
  },
  methods: {
    uuid,
    saveAuthor() { localStorage.setItem('minutes-author', this.author); },
    statusLabel(s) { return { open: '进行中', done: '已完成', cancelled: '已取消' }[s] || s; },
    taskOf(block) { return this.taskByToken(block.token); },
    resolutionOf(block) { return (this.state?.resolutions || []).find(r => r.client_token === block.token); },

    async loadMeetings() {
      this.meetings = await api('/api/meetings');
      if (!this.currentId && this.meetings.length) this.selectMeeting(this.meetings[0].id);
    },
    async newMeeting() {
      const title = prompt('会议标题', '新的会议');
      if (!title) return;
      const m = await api('/api/meetings', { method: 'POST', body: { title } });
      await this.loadMeetings();
      this.selectMeeting(m.id);
    },
    async selectMeeting(id) {
      this.currentId = id;
      await this.reload();
    },
    async reload() {
      if (!this.currentId) return;
      this.state = await api(`/api/meetings/${this.currentId}`);
      this.stateToEditor();
      this.conflict = null; this.finalizeInfo = null; this.histories = {};
    },
    stateToEditor() {
      const s = this.state;
      this.meetingTitle = s.meeting.title;
      this.baseVersionNo = s.latest_version_no;
      this.agenda = (s.content.agenda || []).map(a => ({ ...a }));
      // 待办块字段以任务实体为准（正文与汇总表同源）
      this.blocks = (s.content.blocks || []).map(b => {
        if (b.type === 'todo') {
          const t = this.taskByToken(b.token);
          if (t) {
            return {
              id: b.id, type: 'todo', token: b.token,
              title: t.title, owner: t.owner || '',
              due_kind: t.due_kind, due_date: t.due_date,
              due_at_local: t.due_at ? utcIsoToZonedLocal(t.due_at, t.due_tz) : '',
              due_tz: t.due_tz || 'Asia/Shanghai',
              resolution_token: t.resolution ? t.resolution.client_token : null,
            };
          }
          return { due_kind: 'none', due_tz: 'Asia/Shanghai', resolution_token: null, ...b };
        }
        return { ...b };
      });
    },
    editorToContent() {
      return {
        agenda: this.agenda.filter(a => a.title.trim()).map(a => ({ id: a.id, title: a.title.trim() })),
        blocks: this.blocks.map(b => {
          if (b.type === 'paragraph') return { id: b.id, type: 'paragraph', text: b.text || '' };
          if (b.type === 'resolution') return { id: b.id, type: 'resolution', token: b.token, text: b.text || '' };
          const due = { due_kind: b.due_kind || 'none' };
          if (due.due_kind === 'date') { due.due_date = b.due_date || null; due.due_tz = b.due_tz || 'Asia/Shanghai'; }
          if (due.due_kind === 'datetime') {
            due.due_at = b.due_at_local ? zonedLocalToUtcIso(b.due_at_local, b.due_tz || 'Asia/Shanghai') : null;
            due.due_tz = b.due_tz || 'Asia/Shanghai';
          }
          return {
            id: b.id, type: 'todo', token: b.token, title: b.title || '',
            owner: b.owner || '', resolution_token: b.resolution_token || null, ...due,
          };
        }),
      };
    },

    addBlock(type) {
      const id = uuid();
      if (type === 'paragraph') this.blocks.push({ id, type, text: '' });
      if (type === 'resolution') this.blocks.push({ id, type, token: uuid(), text: '' });
      if (type === 'todo') this.blocks.push({
        id, type, token: uuid(), title: '', owner: '',
        due_kind: 'none', due_date: null, due_at_local: '', due_tz: 'Asia/Shanghai', resolution_token: null,
      });
    },
    removeBlock(i) {
      const b = this.blocks[i];
      if (b.type === 'todo' && this.taskOf(b)) {
        if (!confirm('删除该段落不会取消已建立的待办（任务仍保留在汇总表中）。确定删除？')) return;
      }
      this.blocks.splice(i, 1);
    },
    duplicateTodoRef(i) {
      const b = this.blocks[i];
      this.blocks.splice(i + 1, 0, { ...b, id: uuid() }); // 同一 token：正文的另一处引用同一任务
      this.notice = '已在正文插入同一待办的第二处引用（仍对应同一任务实体）';
    },

    async renameMeeting() { /* 标题随保存一起走，无需单独接口 */ },

    async save(force = false) {
      this.saving = true; this.error = null;
      try {
        if (!this.saveToken || force) this.saveToken = uuid();
        const out = await api(`/api/meetings/${this.currentId}/versions`, {
          method: 'POST',
          body: {
            base_version_no: force ? this.state.latest_version_no : this.baseVersionNo,
            content: this.editorToContent(),
            author: this.author || '匿名',
            save_token: this.saveToken,
            title: this.meetingTitle,
          },
        });
        this.state = out.state;
        this.baseVersionNo = out.version_no;
        this.saveToken = null; this.conflict = null;
        this.notice = out.idempotent ? '已保存（重复请求被幂等忽略）' : `已保存为第 ${out.version_no} 版`;
        this.stateToEditor();
      } catch (e) {
        if (e.status === 409 && e.body?.error === 'version_conflict') {
          this.conflict = e.body; // 离线并行修改：提示合并
        } else if (e.status === 409 && e.body?.error === 'meeting_finalized') {
          this.error = '会议已定稿，正文锁定'; await this.reload();
        } else {
          this.error = e.body?.message || e.message;
        }
      } finally { this.saving = false; }
    },
    async reloadLatest() { await this.reload(); this.notice = '已载入最新版本，本地修改已放弃'; },
    async forceSave() { this.conflict = null; await this.save(true); },

    async finalize() {
      this.error = null;
      // 先保存未落盘内容
      if (!this.finalized) await this.save();
      if (this.conflict) return;
      try {
        const out = await api(`/api/meetings/${this.currentId}/finalize`, {
          method: 'POST', body: { author: this.author || '匿名' },
        });
        this.finalizeInfo = out;
        await this.reload();
        this.finalizeInfo = out;
        this.notice = out.already ? '会议此前已定稿（幂等返回）' : `已定稿为第 ${out.version_no} 版`;
      } catch (e) { this.error = e.body?.message || e.message; }
    },

    async ack(task) {
      const acked_by = prompt(`以谁的名字签收「${task.title}」？`, task.owner || this.author);
      if (!acked_by) return;
      try {
        await api(`/api/tasks/${task.id}/ack`, { method: 'POST', body: { acked_by } });
        await this.reload(); this.notice = `${task.code} 已签收`;
      } catch (e) { this.error = e.body?.message || e.message; }
    },
    async setStatus(task, status) {
      try {
        await api(`/api/tasks/${task.id}/status`, { method: 'POST', body: { status } });
        await this.reload();
      } catch (e) { this.error = e.body?.message || e.message; }
    },
    openReassign(task) {
      this.reassignTask = task;
      this.reassignForm = { owner_name: '', ticket: '', reason: '' };
    },
    async submitReassign() {
      const t = this.reassignTask;
      try {
        await api(`/api/tasks/${t.id}/assignment`, {
          method: 'POST',
          body: {
            owner_name: this.reassignForm.owner_name,
            ticket: this.reassignForm.ticket || undefined,
            reason: this.reassignForm.reason || undefined,
            actor: this.author || '匿名',
            change_token: uuid(),
          },
        });
        this.reassignTask = null;
        await this.reload();
        this.notice = `${t.code} 负责人已变更（旧签收不适用于新分派，需重新签收）`;
      } catch (e) { this.error = e.body?.message || e.message; }
    },
    async toggleHistory(task) {
      if (this.histories[task.id]) { const h = { ...this.histories }; delete h[task.id]; this.histories = h; return; }
      const h = await api(`/api/tasks/${task.id}/history`);
      this.histories = { ...this.histories, [task.id]: h };
    },
    async withdraw(res) {
      if (!confirm(`撤回决议 ${res.code}？关联待办不会被取消，仅标注“已撤回”。`)) return;
      try {
        await api(`/api/resolutions/${res.id}/withdraw`, { method: 'POST' });
        await this.reload();
      } catch (e) { this.error = e.body?.message || e.message; }
    },
    openExport() {
      if (!this.exportVersionNo) return;
      window.open(`/api/meetings/${this.currentId}/export?version_no=${this.exportVersionNo}`, '_blank');
      this.exportVersionNo = null;
    },
  },
  mounted() { this.loadMeetings(); },
}).mount('#app');
