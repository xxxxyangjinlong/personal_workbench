import React, { useEffect, useState } from 'react';
import { api } from '../api';

// 把主目录前缀显示成 ~（与 codex 客户端一致）
function prettyPath(p, home) {
  if (!p) return '';
  if (home && p === home) return '~';
  if (home && p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

// 项目新建/编辑弹窗：手机端（Sessions）与桌面端（Desktop）共用。
// project 传 null 表示新建；传项目对象表示编辑（含删除入口）。
// 带文件夹浏览器：默认打开在用户主目录（~/），点子目录即进入并选中，也可直接手填路径。
export default function ProjectDialog({ project, cwds = [], onClose, onSaved }) {
  const editing = !!project?.id;
  const [name, setName] = useState(project?.name || '');
  const [dir, setDir] = useState(project?.roots?.[0]?.path || '');
  const [busy, setBusy] = useState(false);

  // 文件夹浏览器状态：browsePath 为空串 = 服务端默认主目录
  const [browsePath, setBrowsePath] = useState(project?.roots?.[0]?.path || '');
  const [browse, setBrowse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.fsList(browsePath)
      .then((r) => { if (alive) { setBrowse(r); setError(''); } })
      .catch((e) => {
        if (!alive) return;
        if (browsePath) setBrowsePath(''); // 起始目录不可浏览时回退主目录
        else setError(e.message || '浏览失败');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [browsePath]);

  function go(p) {
    if (!p) return;
    setBrowsePath(p);
    setDir(p); // 进入即选中
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      if (editing) await api.updateProject(project.id, { name, path: dir });
      else await api.createProject({ name, path: dir });
      onSaved();
      onClose();
    } catch (e) {
      window.alert('保存失败：' + e.message);
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    if (!window.confirm(`删除项目「${project.name || name}」？\n只解除分组，项目下的会话不会被删除。`)) return;
    setBusy(true);
    try {
      await api.deleteProject(project.id);
      onSaved();
      onClose();
    } catch (e) {
      window.alert('删除失败：' + e.message);
      setBusy(false);
    }
  }

  const dirs = browse?.dirs || [];
  const home = browse?.home || '';

  return (
    <div className="pmodal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pmodal-card">
        <div className="pmodal-title">{editing ? '编辑项目' : '新建项目'}</div>
        <label className="pmodal-lbl">名称（留空则取目录名）</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：indexSystem" />

        <div className="fbrowse">
          <div className="fbrowse-head">
            <button className="ghost" disabled={loading || !browse?.parent} onClick={() => go(browse.parent)}>← 上级</button>
            <span className="fbrowse-path" title={browse?.path || ''}>{loading ? '加载中…' : prettyPath(browse?.path, home)}</span>
            <button className="ghost" disabled={loading || !browse?.path} onClick={() => setDir(browse.path)}>✓ 选当前</button>
          </div>
          {error && <div className="fbrowse-empty">{error}</div>}
          {!error && !loading && dirs.length === 0 && <div className="fbrowse-empty">没有子文件夹</div>}
          {dirs.length > 0 && (
            <div className="fbrowse-grid">
              {dirs.map((d) => (
                <button key={d.path} className="fbrowse-dir" title={d.path} onClick={() => go(d.path)}>{d.name}</button>
              ))}
            </div>
          )}
        </div>

        <label className="pmodal-lbl">根目录（可手填，支持 ~）</label>
        <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~/IdeaProjects/foo" list="pmodal-cwds" />
        <datalist id="pmodal-cwds">
          {cwds.map((c) => <option key={c} value={c} />)}
        </datalist>
        <div className="pmodal-tip">该项目下的新会话将以此目录为工作目录，与电脑端 Codex 客户端的项目列表同步。</div>
        <div className="pmodal-row">
          {editing && <button className="ghost danger" onClick={remove} disabled={busy}>删除项目</button>}
          <span className="spacer" />
          <button className="ghost" onClick={onClose} disabled={busy}>取消</button>
          <button onClick={save} disabled={busy || !dir.trim()}>{editing ? '保存' : '创建'}</button>
        </div>
      </div>
    </div>
  );
}
