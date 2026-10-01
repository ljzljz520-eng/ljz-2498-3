/* global Vue */
const { createApp } = Vue;

const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = r.status === 204 ? null : await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data?.message || r.statusText), { status: r.status, data });
  return data;
};
const uid = p => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

createApp({
  data() {
    return {
      meetings: [],
      currentId: null,
      meeting: null,
      blocks: [],
      tasks: [],
      decisions: [],
      snapshots: [],
      jobs: [],
      baseRev: 0,
      actor: 'alice',
      newMtg: { title: '', timezone: 'Asia/Shanghai' },
      blockDraft: [],      // 页面本地编辑缓冲
      taskDraft: [],       // 任务编辑缓冲（稳定 id）
      decForm: { code: '', content: '', task_ids: [] },
      finalKey: uid('fin'),
      allowMissing: false,
      exportMd: '',
      exportSnap: '',
      conflict: null,
      toasts: [],
      renderResult: '',
    };
  },
  computed: {
    finalized() { return this.meeting && this.meeting.status !== 'draft'; },
    establishedCount() { return this.tasks.filter(t => t.status === 'established').length; },
    provisionalCount() { return this.tasks.filter(t => t.status === 'provisional').length; },
    missing() { return this.tasks.filter(t => t.status !== 'cancelled' && !t.assignee); },
    todoBlocks() { return this.blockDraft.filter(b => b.type === 'todo'); },
  },
  async mounted() { await this.loadMeetings(); },
  methods: {
    toast(kind, msg) { const id = uid('t'); this.toasts.push({ id, kind, msg }); setTimeout(() => this.toasts = this.toasts.filter(t => t.id !== id), 4200); },

    async loadMeetings() {
      this.meetings = await api('GET', '/api/meetings');
      if (!this.currentId && this.meetings[0]) await this.open(this.meetings[0].id);
    },
    async createMeeting() {
      if (!this.newMtg.title) return this.toast('error', '请填写标题');
      const m = await api('POST', '/api/meetings', { ...this.newMtg, actor: this.actor });
      this.newMtg.title = '';
      await this.loadMeetings();
      await this.open(m.id);
      this.toast('success', '会议已创建');
    },
    async open(id) {
      this.currentId = id;
      this.conflict = null;
      await this.refresh();
    },
    async refresh() {
      this.meeting = await api('GET', `/api/meetings/${this.currentId}`);
      const head = await api('GET', `/api/meetings/${this.currentId}/head`);
      this.blocks = head.blocks;
      this.baseRev = this.meeting.head_rev;
      this.blockDraft = JSON.parse(JSON.stringify(this.blocks));
      this.tasks = await api('GET', `/api/meetings/${this.currentId}/tasks`);
      // 任务面板：服务端实体为唯一真源；草稿仅补充尚未保存的新行
      const known = new Set(this.taskDraft.map(t => t.id));
      for (const t of this.tasks) {
        if (!known.has(t.id)) this.taskDraft.push(this.toDraft(t));
      }
      this.taskDraft = this.taskDraft.filter(t => this.tasks.some(s => s.id === t.id) || t.__new);
      this.decisions = await api('GET', `/api/meetings/${this.currentId}/decisions`);
      this.snapshots = await api('GET', `/api/meetings/${this.currentId}/snapshots`);
      this.jobs = await api('GET', `/api/meetings/${this.currentId}/render`);
    },
    toDraft(t) {
      return { id: t.id, title: t.title, detail: t.detail || '', assignee: t.assignee || '',
               dueKind: t.due_kind || 'date', due: t.due_kind === 'datetime' ? this.wallFromT(t) : (t.due_date || ''),
               tz: t.due_tz || this.meeting.timezone, status: t.status };
    },
    wallFromT(t) {
      // 把 UTC 转回录入时区墙上时间用于回填
      const d = new Date(t.due_at_utc);
      const p = new Intl.DateTimeFormat('sv-SE', { timeZone: t.due_tz || this.meeting.timezone, hourCycle: 'h23',
        year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(d);
      const g = k => p.find(x => x.type === k).value;
      return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
    },

    // ---- 正文块（页面输入）----
    addBlock(type) {
      this.blockDraft.push({ id: uid('blk'), type, ord: this.blockDraft.length, content: '', task_id: type === 'todo' ? '' : null });
    },
    removeBlock(i) {
      const [b] = this.blockDraft.splice(i, 1);
      b.__deleted = true;
      this.blockDraft.__removed = this.blockDraft.__removed || [];
      this.blockDraft.__removed.push(b);
    },
    // 页面选择该 todo 块引用哪个任务实体（正文与汇总表同源）
    linkTaskDraft(b, e) { b.task_id = e.target.value || null; },

    buildOps() {
      const ops = [];
      const cur = new Map(this.blocks.map(b => [b.id, b]));
      for (const b of this.blockDraft) {
        ops.push({ op: 'upsert', block_id: b.id, type: b.type, ord: b.ord, content: b.content, task_id: b.task_id || null });
      }
      for (const b of this.blockDraft.__removed || []) if (cur.has(b.id)) ops.push({ op: 'delete', block_id: b.id });
      return ops;
    },
    async saveBlocks() {
      try {
        const ops = this.buildOps();
        const r = await api('POST', `/api/meetings/${this.currentId}/edit`, { base_rev: this.baseRev, ops, actor: this.actor, note: '页面编辑' });
        this.toast('success', `已提交版本 rev=${r.rev}`);
        this.blockDraft.__removed = [];
        await this.refresh();
      } catch (e) {
        if (e.status === 409 && e.data?.details?.conflicts) { this.conflict = e.data.details.conflicts; this.toast('error', '离线并行冲突'); }
        else this.toast('error', e.message);
      }
    },
    // 冲突后以服务端为基"变基"重放：拉取最新头版本，用户确认后用新 base_rev 重提
    async rebaseAndResubmit() {
      await this.refresh();
      // 简化策略：非删除类本地编辑在新基上重放（删除冲突保留人工处理）
      this.conflict = null;
      try {
        const ops = this.buildOps();
        const r = await api('POST', `/api/meetings/${this.currentId}/edit`, { base_rev: this.baseRev, ops, actor: this.actor });
        this.toast('success', `变基后已提交 rev=${r.rev}`);
        this.blockDraft.__removed = [];
        await this.refresh();
      } catch (e) { this.toast('error', e.message); if (e.data?.details?.conflicts) this.conflict = e.data.details.conflicts; }
    },
    // 模拟"离线并行"：另一会话（bob）基于旧版本抢先写入
    async simulateConcurrentWrite() {
      const tmpBlock = { id: uid('blk'), type: 'para', ord: 999, content: '【bob 离线抢先】补充段落', task_id: null };
      await api('POST', `/api/meetings/${this.currentId}/edit`,
        { base_rev: this.baseRev, ops: [{ op: 'upsert', ...tmpBlock }], actor: 'bob' });
      this.toast('info', 'bob 已基于同版本抢先提交；你现在保存将触发块级三路合并');
    },

    // ---- 任务（编辑即建 provisional，稳定 id 幂等）----
    addTaskDraft() {
      this.taskDraft.push({ __new: true, id: uid('task'), title: '', detail: '', assignee: '', dueKind: 'date', due: '', tz: this.meeting.timezone, status: 'provisional' });
    },
    duePayload(t) {
      if (!t.due) return null;
      return t.dueKind === 'datetime' ? { due: t.due, tz: t.tz } : { due: t.due };
    },
    async saveTasks() {
      const items = this.taskDraft.map(t => ({ id: t.id, title: t.title, detail: t.detail, assignee: t.assignee || undefined,
        due: this.duePayload(t), actor: this.actor }));
      const r = await api('PUT', `/api/meetings/${this.currentId}/tasks`, { items });
      if (r.failed_count) this.toast('error', `部分失败 ${r.failed_count}/${r.total}：` + r.failed.map(f => `[${f.index}]${f.message}`).join('；'));
      else this.toast('success', `已保存 ${r.succeeded_count} 个任务（幂等）`);
      await this.refresh();
    },
    async saveOneTask(t) {
      try {
        await api('PUT', `/api/meetings/${this.currentId}/tasks/${t.id}`,
          { title: t.title, detail: t.detail, assignee: t.assignee || undefined, due: this.duePayload(t), actor: this.actor });
        this.toast('success', '任务已保存（同 ID 重复提交不会重复建）');
        await this.refresh();
      } catch (e) { this.toast('error', e.message); }
    },

    // ---- 负责人独立变更 / 签收 ----
    async changeOwner(t) {
      const reason = prompt(`变更任务「${t.title}」负责人（定稿后也可，独立于正文）。\n当前：${t.assignee || '（缺失）'}\n请输入新负责人（留空=清除）：`, t.assignee || '');
      if (reason === null) return;
      const r = await api('POST', `/api/meetings/${this.currentId}/tasks/${t.id}/assignee`,
        { assignee: reason || null, reason: '页面独立变更', actor: this.actor });
      this.toast('success', r.unchanged ? '负责人无变化' : `负责人已变更（旧签收不再确认新分派）`);
      await this.refresh();
    },
    async ack(t) {
      try {
        await api('POST', `/api/meetings/${this.currentId}/tasks/${t.id}/acknowledge`, { by: this.actor });
        this.toast('success', `已对当前分派版本签收（assignment ${t.assignment_id?.slice(-6)}）`);
        await this.refresh();
      } catch (e) { this.toast('error', e.message); }
    },

    // ---- 决议 ----
    async createDecision() {
      try {
        await api('POST', `/api/meetings/${this.currentId}/decisions`,
          { code: this.decForm.code, content: this.decForm.content, task_ids: this.decForm.task_ids, actor: this.actor });
        this.decForm = { code: '', content: '', task_ids: [] };
        this.toast('success', '决议已建立（业务接口维护任务引用）');
        await this.refresh();
      } catch (e) { this.toast('error', e.message); }
    },
    async withdrawDecision(d) {
      if (!confirm(`撤回决议 ${d.code}？已分派任务不会被自动取消；若已定稿将生成修正案快照。`)) return;
      const r = await api('POST', `/api/meetings/${this.currentId}/decisions/${d.id}/withdraw`,
        { reason: '页面撤回', actor: this.actor });
      this.toast('success', r.amendment_snapshot_id ? '决议已撤回并生成修正案快照' : '决议已撤回');
      await this.refresh();
    },

    // ---- 定稿 ----
    async finalize() {
      try {
        const r = await api('POST', `/api/meetings/${this.currentId}/finalize`,
          { idempotency_key: this.finalKey, allow_missing_assignees: this.allowMissing, actor: this.actor });
        this.toast('success', r.conflict ? `幂等返回既有快照 ${r.snapshot_id?.slice(-6)}`
          : `定稿完成，建立任务 ${r.established_task_ids?.length || 0} 个`);
        await this.refresh();
      } catch (e) {
        if (e.data?.details?.missing) this.toast('error', `负责人缺失 ${e.data.details.missing.length} 项；勾选"允许缺失"可强制定稿`);
        else this.toast('error', e.message);
      }
    },
    replayFinalize() { this.finalize(); },

    // ---- 渲染（含表格阶段中断 + 断点续跑）----
    async render(injectFail) {
      const token = uid('render');
      try {
        if (injectFail) await api('POST', '/api/_test/fail-next-render', { stage: 'render_todo_table' });
        const r = await api('POST', `/api/meetings/${this.currentId}/render`, { client_token: token });
        this.renderResult = r.result_md;
        this.toast('success', r.resumed ? '断点续跑完成' : '正式纪要生成完成');
      } catch (e) {
        if (e.status === 503) {
          this.toast('error', `渲染在「待办汇总表」阶段中断（检查点保留）：token=${token}`);
          this._pendingToken = token;
        } else this.toast('error', e.message);
      }
      await this.refresh();
    },
    async resumeRender() {
      const token = this._pendingToken || prompt('输入要续跑的 client_token');
      if (!token) return;
      try {
        const r = await api('POST', `/api/meetings/${this.currentId}/render`, { client_token: token });
        this.renderResult = r.result_md;
        this.toast('success', r.resumed ? '从断点续跑成功（前序阶段未重算）' : '渲染完成');
        this._pendingToken = null;
      } catch (e) { this.toast('error', e.message); }
      await this.refresh();
    },

    // ---- 导出：只从快照还原 ----
    async doExport() {
      const qs = this.exportSnap ? `?snapshot_id=${this.exportSnap}` : '';
      const r = await api('GET', `/api/meetings/${this.currentId}/export.json${qs}`);
      this.exportMd = r.markdown;
      this.toast('success', `已按快照 ${r.snapshot_id.slice(-6)} 还原（含当时负责人，不含后续任务状态）`);
    },
        liveTask(t) { return this.tasks.find(x => x.id === t.id) || t; },
    liveStatus(t) { const live = this.tasks.find(x => x.id === t.id); return live ? live.status : t.status; },
    titleOf(id) { const t = this.tasks.find(x => x.id === id); return t ? t.title : id; },
    changeOwnerById(id) { const t = this.tasks.find(x => x.id === id) || this.taskDraft.find(x => x.id === id); return this.changeOwner(t); },
    ackById(id) { const t = this.tasks.find(x => x.id === id); return this.ack(t); },
  },

  template: `
  <div class="wrap">
    <div class="sidebar">
      <h1>会议纪要编辑器</h1>
      <div class="muted">当前操作人
        <select v-model="actor" style="margin:4px 0;width:100%">
          <option>alice</option><option>bob</option><option>carol</option>
        </select>
      </div>
      <h3>新建会议</h3>
      <input class="wide" v-model="newMtg.title" placeholder="会议标题" />
      <input class="wide" v-model="newMtg.timezone" placeholder="时区 IANA" style="margin-top:6px" />
      <button style="margin-top:6px;width:100%" @click="createMeeting">创建</button>
      <h3>会议列表</h3>
      <div v-for="m in meetings" :key="m.id" class="mt-item" :class="{active:m.id===currentId}" @click="open(m.id)">
        {{ m.title }}
        <span class="badge" :class="m.status">{{ m.status === 'draft' ? '待定稿' : m.status === 'amended' ? '已定稿(有修正)' : '已定稿' }}</span>
        <div class="muted">{{ m.timezone }} · rev {{ m.head_rev }}</div>
      </div>
    </div>

    <div class="main" v-if="meeting">
      <div class="row" style="justify-content:space-between">
        <h1 style="margin:0">
          {{ meeting.title }}
          <span class="badge" :class="meeting.status">{{ meeting.status === 'draft' ? '会议待定稿' : meeting.status === 'amended' ? '会议已定稿·有修正' : '会议已定稿' }}</span>
          <span class="badge established" v-if="establishedCount">待办已建立 {{ establishedCount }}</span>
          <span class="badge provisional" v-if="provisionalCount && !finalized">待办未建立 {{ provisionalCount }}</span>
        </h1>
        <div class="muted">会议时区 {{ meeting.timezone }} · head rev {{ meeting.head_rev }} · 编辑基线 {{ baseRev }}</div>
      </div>

      <div v-if="missing.length" class="card" style="border-color:#f54a45">
        <b class="err">负责人缺失 {{ missing.length }} 项：</b>
        <span v-for="t in missing" :key="t.id"><span class="badge missing">{{ t.title }}</span> </span>
      </div>

      <h2>① 正文（议题 / 待办块，页面输入）</h2>
      <div class="muted">todo 块通过下拉关联到任务实体——正文待办与下方汇总表来自同一行；删除块不会取消任务。</div>
      <div v-for="(b,i) in blockDraft" :key="b.id" class="block-row">
        <select v-model="b.type" :disabled="finalized">
          <option value="heading">议题</option><option value="para">段落</option><option value="todo">待办</option>
        </select>
        <input v-model.number="b.ord" type="number" title="顺序" :disabled="finalized" />
        <input v-model="b.content" :placeholder="b.type==='todo' ? '待办描述…' : '正文…'" :disabled="finalized" />
        <select v-if="b.type==='todo'" :value="b.task_id||''" @change="linkTaskDraft(b,$event)" :disabled="finalized">
          <option value="">— 关联任务实体 —</option>
          <option v-for="t in tasks" :key="t.id" :value="t.id">{{ t.title }}（{{ t.assignee || '缺失' }}）</option>
        </select>
        <span v-else></span>
        <button class="danger" @click="removeBlock(i)" :disabled="finalized">删段</button>
      </div>
      <div class="row" style="margin-top:6px">
        <button class="ghost" @click="addBlock('heading')" :disabled="finalized">+议题</button>
        <button class="ghost" @click="addBlock('para')" :disabled="finalized">+段落</button>
        <button class="ghost" @click="addBlock('todo')" :disabled="finalized">+待办块</button>
        <button @click="saveBlocks" :disabled="finalized">保存正文（base={{baseRev}}）</button>
        <button class="ghost" @click="simulateConcurrentWrite" :disabled="finalized">模拟他人离线抢先提交</button>
      </div>
      <div v-if="conflict" class="conflict" style="margin-top:8px">
        <b>离线并行冲突（块级三路合并报告）：</b>
        <div v-for="(c,i) in conflict" :key="i">块 {{ c.block_id }}：{{ c.reason }}
          <span v-if="c.field"> [字段 {{ c.field }}：服务端="{{ c.head }}" vs 你的="{{ c.client }}"]</span>
        </div>
        <button style="margin-top:6px" @click="rebaseAndResubmit">拉取最新版本并变基重放</button>
      </div>

      <h2>② 任务实体（编辑即建 provisional；定稿转 established）</h2>
      <table>
        <tr><th>事项</th><th>负责人</th><th>截止（仅日期/具体时刻）</th><th>状态</th><th>签收</th><th>操作</th></tr>
        <tr v-for="t in taskDraft" :key="t.id">
          <td><input v-model="t.title" :disabled="finalized && !t.__new" style="width:100%" />
            <div class="muted">{{ t.id }}</div></td>
          <td><input v-model="t.assignee" :disabled="finalized" placeholder="可留空=缺失" />
            <div v-if="t.status==='established'" class="muted">定稿后改负责人请用右侧按钮</div></td>
          <td>
            <select v-model="t.dueKind">
              <option value="date">仅日期</option><option value="datetime">具体时刻+时区</option>
            </select>
            <input v-model="t.due" :placeholder="t.dueKind==='date'?'YYYY-MM-DD':'YYYY-MM-DDTHH:mm'" style="margin-top:4px" />
            <input v-if="t.dueKind==='datetime'" v-model="t.tz" style="margin-top:4px" placeholder="IANA 时区" />
            <div class="muted" v-if="t.dueKind==='date'">按会议时区 {{ meeting.timezone }} 的日历日解释，无时刻</div>
          </td>
          <td>
            <span class="badge" :class="liveStatus(t)">{{ liveStatus(t) === 'established' ? '已建立' : liveStatus(t) === 'provisional' ? '编辑态' : liveStatus(t) }}</span>
          </td>
          <td><AckCell :t="liveTask(t)" /></td>
          <td>
            <button class="ghost" @click="saveOneTask(t)" v-if="!finalized">幂等保存</button>
            <button class="ghost" @click="changeOwnerById(t.id)">变更负责人</button>
            <button class="ghost" @click="ackById(t.id)" v-if="liveTask(t) && liveTask(t).assignee">签收</button>
          </td>
        </tr>
      </table>
      <div class="row">
        <button class="ghost" @click="addTaskDraft" :disabled="finalized">+任务（编辑即建）</button>
        <button @click="saveTasks" :disabled="finalized">批量保存（部分失败不影响其他项）</button>
      </div>

      <h2>③ 决议（业务接口维护决议↔任务引用）</h2>
      <div v-for="d in decisions" :key="d.id" class="card">
        <b>{{ d.code }}</b> <span :class="d.status==='withdrawn'?'err':'ok'">{{ d.status === 'withdrawn' ? '（已撤回，引用保留可追溯，任务不取消）' : '' }}</span>
        <div>{{ d.content }}</div>
        <div style="margin-top:4px">
          <span v-for="tid in d.task_ids" :key="tid" class="tag-ref">⟶ {{ titleOf(tid) }}</span>
        </div>
        <button class="danger" style="margin-top:6px" @click="withdrawDecision(d)" v-if="d.status==='active'">撤回决议{{ finalized ? '（生成修正案）' : '' }}</button>
      </div>
      <div class="card">
        <div class="row">
          <input v-model="decForm.code" placeholder="编号 D-1" style="width:110px" :disabled="finalized" />
          <input v-model="decForm.content" placeholder="决议内容" style="flex:1" :disabled="finalized" />
        </div>
        <div style="margin-top:6px" v-if="!finalized">
          引用任务（同一任务可被多决议/多处引用）：
          <label v-for="t in tasks" :key="t.id" style="margin-right:10px">
            <input type="checkbox" :value="t.id" v-model="decForm.task_ids" /> {{ t.title }}
          </label>
        </div>
        <button style="margin-top:6px" @click="createDecision" :disabled="finalized">建立决议</button>
      </div>

      <h2>④ 定稿 · 渲染 · 导出</h2>
      <div class="row">
        <input v-model="finalKey" style="width:260px" title="定稿幂等键" />
        <label><input type="checkbox" v-model="allowMissing" /> 允许负责人缺失定稿</label>
        <button @click="finalize" :disabled="finalized">定稿</button>
        <button class="ghost" @click="replayFinalize">同键重放（验证幂等）</button>
      </div>
      <div class="muted">快照：
        <span v-for="s in snapshots" :key="s.id" class="tag-ref">{{ s.kind }}#{{ s.seq }} {{ s.trigger }} {{ s.content_hash.slice(0,8) }}</span>
      </div>
      <div class="row" style="margin-top:8px">
        <button @click="render(false)" :disabled="!snapshots.length">生成正式纪要</button>
        <button class="danger" @click="render(true)" :disabled="!snapshots.length">注入故障：汇总表阶段中断</button>
        <button class="ghost" @click="resumeRender">用同 client_token 断点续跑</button>
      </div>
      <table style="margin-top:6px" v-if="jobs.length">
        <tr><th>token</th><th>状态</th><th>阶段进度</th><th>尝试次数</th></tr>
        <tr v-for="j in jobs" :key="j.id"><td class="muted">{{ j.client_token }}</td><td>{{ j.status }}</td><td>{{ j.stage }} ({{ j.stage_seq }}/5)</td><td>{{ j.attempts }}</td></tr>
      </table>

      <div class="row" style="margin-top:10px">
        <select v-model="exportSnap">
          <option value="">最新快照（含修正案）</option>
          <option v-for="s in snapshots" :key="s.id" :value="s.id">{{ s.kind }} #{{ s.seq }}</option>
        </select>
        <button class="ghost" @click="doExport" :disabled="!snapshots.length">导出/还原当时负责人</button>
      </div>
      <pre class="doc" v-if="renderResult || exportMd">{{ renderResult || exportMd }}</pre>
    </div>

    <div class="toast"><div v-for="t in toasts" :key="t.id" class="t" :class="t.kind">{{ t.msg }}</div></div>
  </div>
  `,
  components: {
    AckCell: { props: ['t'], template: `<span v-if="t"><span :class="t.acknowledged?'ok':'muted'">{{ t.acknowledged ? '当前分派已签收' : '未签收' }}</span></span><span v-else class="muted">—</span>` }
  },
}).mount('#app');
