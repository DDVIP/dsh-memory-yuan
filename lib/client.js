/**
 * dsh-memory-yuan 的 Web 半边：右上角「记忆」按钮 + 浮层面板。
 *
 * 设计稿：不要做成「记忆管理器」，做成「这一轮我带了什么进来」。
 * 数据不走 IPC，全从 host 的 /memory-yuan/* 路由读（进程内 HTTP，不出机器）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-yuan',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    // ---- 按钮与面板共享的开合状态（模块级，跨 slot 实例） ----
    const listeners = new Set();
    let open = false;
    function setOpen(next) {
      if (open === next) return;
      open = next;
      for (const listener of listeners) listener(open);
    }
    function useOpen() {
      const [value, setValue] = useState(open);
      useEffect(() => {
        const listener = (next) => setValue(next);
        listeners.add(listener);
        setValue(open);
        return () => listeners.delete(listener);
      }, []);
      return value;
    }

    const STATUS_NOTE = {
      verified: '已确认：不再占每轮预算，L1 按线索还能找到',
      disputed: '已标为有争议：L0/L1 都不带它',
      superseded: '已废弃：文件保留，只是不再被当成结论',
    };

    // ---- 从「记忆」面板跳到左栏星图：请求把某条记忆高亮（模块级，跨 slot） ----
    let focusRequest = null;
    const focusListeners = new Set();
    function requestGraphFocus(id) {
      focusRequest = { id, at: Date.now() };
      for (const listener of focusListeners) listener(focusRequest);
    }
    function useGraphFocus() {
      const [value, setValue] = useState(focusRequest);
      useEffect(() => {
        const listener = (next) => setValue(next);
        focusListeners.add(listener);
        setValue(focusRequest);
        return () => focusListeners.delete(listener);
      }, []);
      return value;
    }

    async function request(path, init) {
      const res = await fetch(`/memory-yuan${path}`, {
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        ...init,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      return body;
    }

    // ---- 主题：深色半透明，跟随宿主观感的低饱和配色 ----
    const T = {
      panel: 'rgba(20, 22, 28, 0.97)',
      border: 'rgba(255, 255, 255, 0.12)',
      divider: 'rgba(255, 255, 255, 0.08)',
      text: 'rgba(236, 238, 245, 0.94)',
      dim: 'rgba(200, 205, 220, 0.62)',
      faint: 'rgba(200, 205, 220, 0.42)',
      accent: 'rgba(120, 180, 255, 0.95)',
      accentSoft: 'rgba(120, 180, 255, 0.14)',
      danger: 'rgba(255, 140, 140, 0.92)',
    };

    // ---- 原生左栏入口：sidebar.panellist 的图标 + main 面板用同一个 key ----
    const GRAPH_PANEL_ID = 'memory-yuan-graph';

    /** 左栏图标：一颗带渐变的圆点，旁边散着两个小星点（星图的样子）。 */
    function GraphIcon({ size = 18 }) {
      const edge = Math.max(14, Math.min(26, Number(size) || 18));
      return h(
        'span',
        { style: { position: 'relative', width: edge, height: edge, display: 'inline-block' } },
        h('span', {
          style: {
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: Math.round(edge * 0.52),
            height: Math.round(edge * 0.52),
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            background: 'radial-gradient(circle at 32% 30%, #ffe6a3, #78ecff 45%, #6b5bff 100%)',
            boxShadow: '0 0 8px rgba(120, 180, 255, 0.55)',
          },
        }),
        h('span', {
          style: {
            position: 'absolute',
            right: 0,
            top: 1,
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: 'rgba(255, 230, 163, 0.95)',
          },
        }),
        h('span', {
          style: {
            position: 'absolute',
            left: 1,
            bottom: 1,
            width: 3,
            height: 3,
            borderRadius: '50%',
            background: 'rgba(120, 236, 255, 0.85)',
          },
        }),
      );
    }

    const S = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '26px',
        padding: '0 9px',
        fontSize: '12px',
        lineHeight: 1,
        borderRadius: '6px',
        border: `1px solid ${T.border}`,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      buttonActive: {
        border: `1px solid ${T.accent}`,
        background: T.accentSoft,
      },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0, 0, 0, 0.28)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'flex-end',
      },
      panel: {
        width: 'min(960px, 96vw)',
        maxHeight: '86vh',
        margin: '54px 14px 14px',
        display: 'flex',
        flexDirection: 'column',
        background: T.panel,
        border: `1px solid ${T.border}`,
        borderRadius: '10px',
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.42)',
        backdropFilter: 'blur(10px)',
        color: T.text,
        fontSize: '13px',
        overflow: 'hidden',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '12px 16px',
        borderBottom: `1px solid ${T.divider}`,
      },
      title: { flex: 1, fontSize: '13px', fontWeight: 600, letterSpacing: '0.2px' },
      iconButton: {
        width: '24px',
        height: '24px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '6px',
        border: 'none',
        background: 'transparent',
        color: T.faint,
        cursor: 'pointer',
        fontSize: '14px',
      },
      body: { padding: '14px 16px 16px', overflowY: 'auto', flex: 1 },
      section: { marginBottom: '16px' },
      section: {
        marginTop: '18px',
      },
      empty: {
        fontSize: '12px',
        color: T.faint,
        padding: '6px 0',
      },
      // 一条记忆一个框：标题、问题行、按钮各自成行，多了也串不起来。
      reviewItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px 12px',
        border: `1px solid ${T.divider}`,
        borderRadius: '8px',
        background: 'rgba(255, 255, 255, 0.025)',
      },
      reviewTitle: {
        fontSize: '13px',
        fontWeight: 600,
        lineHeight: 1.45,
      },
      reviewWhy: {
        fontSize: '12px',
        color: T.dim,
        lineHeight: 1.5,
      },
      action: {
        alignSelf: 'flex-start',
        height: '24px',
        padding: '0 8px',
        fontSize: '11px',
        lineHeight: 1,
        borderRadius: '5px',
        border: `1px solid ${T.border}`,
        background: 'transparent',
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: T.text,
      },
      sectionTitle: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '6px',
        margin: '0 0 6px',
        fontSize: '11.5px',
        fontWeight: 600,
        color: T.dim,
        letterSpacing: '0.3px',
      },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '6px',
        padding: '7px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      tag: { color: T.faint, flexShrink: 0 },
      byTag: {
        color: T.accent,
        border: `1px solid ${T.border}`,
        borderRadius: 4,
        padding: '0 4px',
        fontSize: 10,
        lineHeight: '14px',
        flexShrink: 0,
      },
      rowTitle: {
        flex: 1,
        minWidth: 0,
        color: T.text,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      rowMeta: { color: T.faint, flexShrink: 0 },
      rowMetaLine: {
        fontSize: '11px',
        color: T.faint,
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      hit: { color: T.accent, marginLeft: '6px', wordBreak: 'break-all' },
      reviewWhy: { width: '100%', color: T.faint, fontSize: '11px', lineHeight: 1.6, marginTop: '2px' },
      reviewActions: { width: '100%', marginTop: '4px', display: 'flex', alignItems: 'center' },
      empty: { color: T.faint, padding: '4px 6px', lineHeight: 1.6 },
      // 顶部概览：条数 + 四状态分布 + 注入预算进度
      overview: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 9px',
        marginBottom: '12px',
        borderRadius: '8px',
        border: `1px solid ${T.divider}`,
        background: 'rgba(255,255,255,0.025)',
      },
      digestFail: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '2px',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid rgba(255,140,140,0.35)',
        background: 'rgba(255,140,140,0.08)',
        fontSize: '11px',
        lineHeight: 1.6,
        color: T.text,
      },
      overviewRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      stat: { fontSize: '15px', fontWeight: 700, letterSpacing: '0.2px' },
      statHint: { fontSize: '11px', color: T.faint },
      statusChip: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: T.dim },
      dot: { width: '6px', height: '6px', borderRadius: '50%', display: 'inline-block' },
      barTrack: {
        position: 'relative',
        height: '5px',
        borderRadius: '999px',
        background: 'rgba(255,255,255,0.07)',
        overflow: 'hidden',
      },
      barFill: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        borderRadius: '999px',
        background: 'linear-gradient(90deg, rgba(120,180,255,0.6), rgba(120,180,255,0.95))',
        transition: 'width 240ms ease',
      },
      footer: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 12px',
        borderTop: `1px solid ${T.divider}`,
        color: T.faint,
        fontSize: '11px',
      },
      detailTitle: { fontSize: '13px', fontWeight: 600, margin: '0 0 4px' },
      input: {
        height: '30px',
        padding: '0 9px',
        borderRadius: '6px',
        border: `1px solid ${T.border}`,
        background: 'rgba(255, 255, 255, 0.06)',
        color: T.text,
        fontSize: '12px',
        fontFamily: 'inherit',
      },
      detailMeta: { color: T.faint, fontSize: '11px', marginBottom: '8px', wordBreak: 'break-all' },
      pre: {
        margin: 0,
        padding: '8px 10px',
        background: 'rgba(0, 0, 0, 0.28)',
        border: `1px solid ${T.divider}`,
        borderRadius: '8px',
        color: T.text,
        fontSize: '12.5px',
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '46vh',
        overflowY: 'auto',
      },
      action: {
        marginTop: '10px',
        height: '26px',
        padding: '0 10px',
        borderRadius: '6px',
        border: `1px solid ${T.border}`,
        background: 'transparent',
        color: T.danger,
        cursor: 'pointer',
        fontSize: '12px',
      },
      error: { color: T.danger, padding: '6px', lineHeight: 1.6 },
    };

    function shortId(id) {
      const text = String(id ?? '');
      return text.length > 18 ? `${text.slice(0, 18)}…` : text;
    }

    function timeLabel(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    // ---- 右上角「记忆」按钮 ----
    function MemoryButton() {
      const isOpen = useOpen();
      return h(
        'button',
        {
          type: 'button',
          title: '这一轮带了什么记忆',
          onClick: () => setOpen(!isOpen),
          style: isOpen ? { ...S.button, ...S.buttonActive } : S.button,
        },
        '记忆',
      );
    }

    // ---- 浮层面板 ----
    function MemoryPanel() {
      const isOpen = useOpen();
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [detail, setDetail] = useState(null);
      const [busy, setBusy] = useState(false);
      const [view, setView] = useState('round'); // round = 这一轮带了什么；review = 体检单
      const [review, setReview] = useState(null);
      const [lint, setLint] = useState(null);
      const [lintLimit, setLintLimit] = useState(8);
      const [copyHint, setCopyHint] = useState('');
      const [statusView, setStatusView] = useState('');
      const [reviewNote, setReviewNote] = useState('');
      const [evidenceList, setEvidenceList] = useState(null); // null=还没查；[]=查过没命中
      const [evidenceBusy, setEvidenceBusy] = useState(false);
      const [evidenceNote, setEvidenceNote] = useState('');
      function flashReview(text) {
        setReviewNote(text);
        setTimeout(() => setReviewNote(''), 6000);
      }
      const [query, setQuery] = useState('');
      const [debouncedQuery, setDebouncedQuery] = useState('');
      const [sortBy, setSortBy] = useState('recent');
      const [pageIndex, setPageIndex] = useState(0);
      const [related, setRelated] = useState([]);
      const [editing, setEditing] = useState(null);
      const [confirmDelete, setConfirmDelete] = useState(false);
      const [refreshedAt, setRefreshedAt] = useState('');

      const load = useCallback(async () => {
        setBusy(true);
        try {
          const next = await request('/state');
          setState(next);
          setError('');
        } catch (err) {
          setError(err?.message ?? String(err));
        } finally {
          setBusy(false);
        }
      }, []);

      // 结构体检（frontmatter / type / tags / 时间）走 /lint，和内容层面的 /review 分两次拉。
      const loadLint = useCallback(async () => {
        try {
          setLint(await request('/lint'));
        } catch (err) {
          setError(err?.message ?? String(err));
        }
      }, []);

      useEffect(() => {
        if (!isOpen) return undefined;
        load();
        const onVisible = () => {
          if (document.visibilityState === 'visible' && open) load();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
      }, [isOpen, load]);

      useEffect(() => {
        if (!isOpen) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [isOpen]);

      // 250–300ms 防抖：边打字边搜会把每次按键都变成一次全库扫描。
      useEffect(() => {
        const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
        return () => clearTimeout(timer);
      }, [query]);

      const loadReview = useCallback(async () => {
        setBusy(true);
        try {
          setReview(await request('/review'));
          setError('');
        } catch (err) {
          setError(err?.message ?? String(err));
        } finally {
          setBusy(false);
        }
      }, []);

      // 体检单也可能被别处改掉（工具调用、另一个班次、收盘任务），
      // 打开「体检」时每 12 秒静默拉一遍，看到的就是最新单子。
      // 结构体检的「修」：只修文件本身（挪目录、补 frontmatter、清脏字段），不动内容。
      // 结构体检的「忽略」：人明确说「别管这条」，记进 review-ignored.json，之后不再列出。
      const ignoreLint = useCallback(
        async (id) => {
          setBusy(true);
          try {
            await request('/review/ignore', { method: 'POST', body: JSON.stringify({ id, action: 'ignored' }) });
            flashReview('已忽略：结构体检不再列它（清 .dsh-memory/review-ignored.json 可恢复）');
            await loadLint();
          } catch (err) {
            setError(err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
        [loadLint],
      );

      const fixLint = useCallback(
        async (id, code) => {
          setBusy(true);
          try {
            const result = await request('/lint/fix', { method: 'POST', body: JSON.stringify({ id, code }) });
            flashReview(`已修：${result.action ?? code}`);
            await Promise.all([loadLint(), load()]);
          } catch (err) {
            setError(err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
        [load, loadLint],
      );

      const silentRefreshReview = useCallback(async () => {
        try {
          setReview(await request('/review'));
        } catch {
          /* 静默失败：不弹错，等下一次 */
        }
        try {
          setLint(await request('/lint'));
        } catch {
          /* 静默失败 */
        }
      }, []);

      useEffect(() => {
        if (!isOpen || view !== 'review') return undefined;
        const timer = setInterval(() => {
          void silentRefreshReview();
        }, 12000);
        return () => clearInterval(timer);
      }, [isOpen, view, silentRefreshReview]);

      // 改完状态要连同当前视图一起刷新：体检页看的是 review，只刷 state 会「点了没反应」。
      const refresh = useCallback(
        async (targetView = view) => {
          await load();
          if (targetView === 'review') await Promise.all([loadReview(), loadLint()]);
        },
        [load, loadReview, view],
      );

      // 右上角 ↻：不管在哪一页都重拉数据，并给一句「已刷新」回执——否则数据没变时看起来像点坏了。
      const reloadCurrent = useCallback(async () => {
        await refresh();
        setRefreshedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
      }, [refresh]);

      // 出处回溯：翻会话存档找「这条记忆是哪次对话说的」。只给候选，人点了才写。
      const findEvidenceFor = useCallback(async (id) => {
        setEvidenceBusy(true);
        setEvidenceNote('正在翻会话存档……');
        try {
          const res = await request(`/evidence?id=${encodeURIComponent(id)}`);
          const candidates = res?.candidates ?? [];
          setEvidenceList(candidates);
          setEvidenceNote(candidates.length ? '' : '没找到：标题里的词，在用户说过的话里没同时出现过两次。');
        } catch (err) {
          setEvidenceList([]);
          setEvidenceNote(`找失败：${err?.message ?? err}`);
        } finally {
          setEvidenceBusy(false);
        }
      }, []);

      const writeEvidence = useCallback(
        async (text) => {
          if (!detail?.id) return;
          try {
            await request('/evidence', { method: 'POST', body: JSON.stringify({ id: detail.id, evidence: text }) });
            setEvidenceList(null);
            setEvidenceNote(text ? '已写进 frontmatter。' : '已清空出处。');
            await refresh();
            const found = await request(`/memory?id=${encodeURIComponent(detail.id)}`);
            setDetail(found);
          } catch (err) {
            setEvidenceNote(`写失败：${err?.message ?? err}`);
          }
        },
        [detail, refresh],
      );

      const applyEvidence = useCallback(
        (candidate) => {
          const day = String(candidate?.at ?? '').slice(0, 10);
          const session = String(candidate?.sessionId ?? '').replace(/^session-/, '').slice(0, 8);
          const quote = String(candidate?.quote ?? '').replace(/\s+/g, ' ').slice(0, 60);
          return writeEvidence(`${day} 会话 ${session}：「${quote}」`);
        },
        [writeEvidence],
      );

      const loadRelated = useCallback(async (id) => {
        try {
          const res = await request(`/related?id=${encodeURIComponent(id)}`);
          setRelated(res?.related ?? []);
        } catch {
          setRelated([]);
        }
      }, []);

      // 保存编辑：只发改过的字段，标题空着就别动。
      const saveEdit = useCallback(async () => {
        if (!detail || !editing) return;
        setBusy(true);
        try {
          const payload = { id: detail.id };
          if (editing.title.trim() && editing.title !== detail.title) payload.title = editing.title.trim();
          payload.tags = editing.tags.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean);
          if (String(editing.importance).trim() !== '') payload.importance = Number(editing.importance);
          if (editing.content.trim() && editing.content !== detail.text) payload.content = editing.content;
          await request('/update', { method: 'POST', body: JSON.stringify(payload) });
          setEditing(null);
          await refresh();
          const found = await request(`/memory?id=${encodeURIComponent(detail.id)}`);
          setDetail(found);
        } catch (err) {
          setError(`保存失败：${err?.message ?? String(err)}`);
        } finally {
          setBusy(false);
        }
      }, [detail, editing, refresh]);

      // 归档 = 移到 Archive/（不删文件、随时能恢复），先点一下再点一下确认。
      const doDelete = useCallback(async () => {
        if (!detail) return;
        setBusy(true);
        try {
          await request('/delete', { method: 'POST', body: JSON.stringify({ id: detail.id, confirm: true }) });
          setConfirmDelete(false);
          setDetail(null);
          await refresh();
        } catch (err) {
          setError(`归档失败：${err?.message ?? String(err)}`);
        } finally {
          setBusy(false);
        }
      }, [detail, refresh]);
      const openMemory = useCallback(async (id) => {
        setBusy(true);
        try {
          const found = await request(`/memory?id=${encodeURIComponent(id)}`);
          setDetail(found);
          setError('');
          setConfirmDelete(false);
          void loadRelated(found.id);
        } catch (err) {
          setDetail(null);
          setError(`打开失败：${err?.message ?? String(err)}。索引可能过期，点右上角 ↻ 刷新再来。`);
        } finally {
          setBusy(false);
        }
      }, []);

      const supersede = useCallback(
        async (id) => {
          setBusy(true);
          try {
            await request('/supersede', { method: 'POST', body: JSON.stringify({ id }) });
            flashReview('已标为废弃：文件保留，L0/L1 都不再带它');
            setDetail(null);
            await refresh();
          } catch (err) {
            setError(err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
        [refresh],
      );

      // 状态是「人给的章」：verified 才能进 L0，disputed 不进 L0/L1。
      const setStatus = useCallback(
        async (id, status) => {
          setBusy(true);
          try {
            await request('/status', { method: 'POST', body: JSON.stringify({ id, status }) });
            flashReview(STATUS_NOTE[status] ?? `已改为 ${status}`);
            setDetail(null);
            await refresh();
          } catch (err) {
            setError(err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
        [refresh],
      );

      // 确认（verified）与「每轮都带」（pinned）是两件事：常用但不必每轮看的记忆到这里就够。
      const setPinned = useCallback(
        async (id, pinned) => {
          setBusy(true);
          try {
            await request('/pin', { method: 'POST', body: JSON.stringify({ id, pinned }) });
            setDetail(await request(`/memory?id=${encodeURIComponent(id)}`));
            await load();
          } catch (err) {
            setError(err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
        [load],
      );

      const ignoreReview = useCallback(
        async (id) => {
          setBusy(true);
          try {
            await request('/review/ignore', { method: 'POST', body: JSON.stringify({ id }) });
            flashReview('已忽略：清掉 .dsh-memory/review-ignored.json 会重新出现');
            await loadReview();
          } catch (err) {
            setError(err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
        [loadReview],
      );

      // 照体检单上的建议处理一条：先看建议是什么，再决定要不要点。
      // 工具侧只做可逆动作（不删文件、decision/preference 直接拒绝、每条留一行流水）。
      const tendItem = useCallback(
        async (id) => {
          setBusy(true);
          setReviewNote('按建议处理中…');
          try {
            const result = await request('/tend', {
              method: 'POST',
              body: JSON.stringify({ items: [{ id }], dryRun: false }),
            });
            const done = result.applied?.[0];
            const skipped = result.skipped?.[0];
            setReviewNote(
              done
                ? `已处理：${done.action}（${done.before} → ${done.after}），流水记了 ${result.logged ?? 0} 行`
                : `没处理：${skipped?.reason ?? '这条的建议是「不动」'}`,
            );
            await loadReview();
            await load();
          } catch (err) {
            setError(err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
        [load, loadReview],
      );

      // 「留着」「30 天后过期」要真的把条目移出体检单：
      // 光改 status/expires 改不动那几组的判据（noEvidence 看 evidence、unused 看 candidate），
      // 所以这两个动作 = 改文件 + 记一笔 kept。记成 kept 后还能在「已保留」里恢复。
      const keepInReview = useCallback(
        async (id) => {
          setBusy(true);
          try {
            await request('/status', { method: 'POST', body: JSON.stringify({ id, status: 'verified' }) });
            await request('/review/ignore', { method: 'POST', body: JSON.stringify({ id, action: 'kept' }) });
            setReviewNote('已留着：从体检单移到「已保留」，L1 按线索仍能找到');
            await loadReview();
            await load();
          } catch (err) {
            setError(err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
        [load, loadReview],
      );

      // 手动重跑收盘：只在「上次失败」时出现（POST /digest/run）
      const runDigest = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
          const result = await request('/digest/run', { method: 'POST', body: JSON.stringify({}) });
          if (result?.result?.skipped) setReviewNote('今天的收盘已经写过了，跳过');
          else setReviewNote('收盘重跑完成：摘要写进 Daily/');
          await load();
        } catch (err) {
          setError(`重跑失败：` + (err?.message ?? String(err)));
        } finally {
          setBusy(false);
        }
      }, [load]);

      const expireInReview = useCallback(
        async (id, days = 30) => {
          setBusy(true);
          try {
            const at = new Date();
            at.setDate(at.getDate() + days);
            const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
            await request('/expire', { method: 'POST', body: JSON.stringify({ id, expires: stamp }) });
            await request('/review/ignore', { method: 'POST', body: JSON.stringify({ id, action: 'kept' }) });
            setReviewNote(`已设 ${stamp} 过期：到期后不进 L1，到期会在体检单里单列`);
            await loadReview();
            await load();
          } catch (err) {
            setError(err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
        [load, loadReview],
      );

      // 复制正文：详情页最常用的动作（发给别人 / 记到别处）
      const copyText = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(String(detail?.text ?? ''));
          setCopyHint('已复制');
          setTimeout(() => setCopyHint(''), 1500);
        } catch (err) {
          setError(err?.message ?? `复制失败：${String(err)}`);
        }
      }, [detail]);

      // 到期日按本地日期算：设 30 天，就是 30 天后那天的 00:00 起不进 L1。
      const setExpiry = useCallback(
        async (id, days) => {
          setBusy(true);
          try {
            const target = new Date();
            target.setDate(target.getDate() + days);
            const stamp = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(
              target.getDate(),
            ).padStart(2, '0')}`;
            await request('/expire', { method: 'POST', body: JSON.stringify({ id, expires: stamp }) });
            flashReview(`已设 ${stamp} 过期：之后不进 L1，体检单里单列`);
            setDetail(null);
            await refresh();
          } catch (err) {
            setError(err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
        [refresh],
      );

      const unignoreReview = useCallback(
        async (id) => {
          setBusy(true);
          try {
            await request('/review/unignore', { method: 'POST', body: JSON.stringify({ id }) });
            flashReview('已恢复显示');
            await loadReview();
          } catch (err) {
            setError(err?.message ?? String(err));
          } finally {
            setBusy(false);
          }
        },
        [loadReview],
      );

      // 体检每条给几个出口：留着（确认）、30 天后再说、废弃、忽略。
      // 「小用但没到废弃」= 设为已确认（不进 L0，L1 按线索还能找到）；
      // 「暂时有用」= 30 天后过期（到期自动不进 L1，到那时再决定）。
      const reviewRow = (item, key) => {
        const action = (label, onClick, { tone = 'normal', title = '' } = {}) =>
          h(
            'button',
            {
              type: 'button',
              // color 显式给：<button> 不继承父级颜色，undefined 会退回 UA 的黑色，深色面板上就看不清了。
              style: { ...S.action, marginTop: 0, marginLeft: '6px', color: tone === 'faint' ? T.faint : T.text },
              title,
              disabled: busy,
              onClick,
            },
            label,
          );
        return h(
          'div',
          { key, style: { ...S.row, flexWrap: 'wrap' } },
          h(
            'span',
            { style: S.tag },
            item.fromIgnored
              ? item.action === 'kept'
                ? '已保留'
                : '已忽略'
              : item.type
                ? typeLabel(item.type)
                : '可合并',
          ),
          h(
            'span',
            {
              style: { ...S.rowTitle, cursor: item.id ? 'pointer' : 'default' },
              title: item.id ? '点开看全文和出处' : '',
              // 体检里点得开才有用：这条本来就没写出处，详情页里能直接「找出处」。
              onClick: item.id ? () => openMemory(item.id) : undefined,
            },
            item.title ?? `${item.a?.title ?? ''} ／ ${item.b?.title ?? ''}`,
          ),
          item.why ? h('div', { style: S.reviewWhy }, item.why) : null,
          item.suggest && item.suggest.action && item.suggest.action !== 'none'
            ? h('div', { style: S.reviewWhy }, `建议：${SUGGEST_LABEL[item.suggest.action] ?? item.suggest.action}${item.suggest.drop ? `（并掉「${item.suggest.drop.title}」）` : ''}${item.suggest.reason ? `——${item.suggest.reason}` : ''}`)
            : null,
          item.id
            ? h(
                'div',
                { style: S.reviewActions },
                item.fromIgnored
                  ? action('恢复显示', () => unignoreReview(item.id))
                  : action('留着（设为已确认）', () => keepInReview(item.id), {
                      title: '进 verified：不占每轮预算，L1 按线索还能找到；同时从体检单移走',
                    }),
                item.fromIgnored
                  ? null
                  : item.suggest && item.suggest.action && item.suggest.action !== 'none'
                    ? action('照建议处理', () => tendItem(item.id), { title: '按体检单给的建议执行：只做可逆动作、不删文件、每条件一行流水' })
                    : null,
                item.fromIgnored
                  ? null
                  : action('30 天后过期', () => expireInReview(item.id, 30), {
                      title: '暂时有用：到期后不再进 L1，同时从体检单移走',
                    }),
                item.fromIgnored
                  ? null
                  : action('标为已废弃', () => setStatus(item.id, 'superseded')),
                item.fromIgnored
                  ? null
                  : action('忽略', () => ignoreReview(item.id), { tone: 'faint' }),
              )
            : null,
        );
      };

      const reviewGroup = (label, items, keyPrefix) =>
        h(
          'div',
          { style: S.section },
          h('div', { style: S.sectionTitle }, `${label} ${items.length} 条`),
          items.length
            ? items.map((item, index) => reviewRow(item, `${keyPrefix}-${index}`))
            : h('div', { style: S.empty }, '没有'),
        );

      const lintSummary = lint
        ? h(
            'div',
            { style: S.section },
            h(
              'div',
              { style: S.sectionTitle },
              `结构：扫了 ${lint.scanned ?? 0} 条，${lint.flagged ?? 0} 条写得不对（错 ${lint.counts?.error ?? 0} / 警 ${lint.counts?.warning ?? 0}）`,
            ),
            h(
              'div',
              { style: S.reviewWhy },
              '只看文件本身：frontmatter 缺字段、type / status 不认识、tags 脏、正文空、时间倒挂。不改任何文件。',
            ),
            (lint.rows ?? []).slice(0, lintLimit).map((row, index) =>
              h(
                'div',
                { key: `lint-${index}`, style: { ...S.reviewItem, marginTop: index === 0 ? 8 : 6 } },
                h('div', { style: S.reviewTitle }, `${row.level === 'error' ? '错' : row.level === 'warning' ? '警' : '提示'} · ${row.title}`),
                h(
                  'div',
                  { style: S.reviewWhy },
                  (row.problems ?? []).map((item, pIndex) =>
                    h(
                      'div',
                      { key: `p-${pIndex}`, style: { marginTop: pIndex === 0 ? 0 : 3 } },
                      `${item.message}（${item.fix ?? '—'}）`,
                      (lint.fixable ?? []).includes(item.code)
                        ? h(
                            'button',
                            {
                              type: 'button',
                              style: { ...S.action, marginTop: 4, marginLeft: 0, color: T.text },
                              onClick: () => fixLint(row.id, item.code),
                            },
                            `修：${item.fix ?? item.code}`,
                          )
                        : null,
                    ),
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' } },
                  h(
                    'button',
                    {
                      type: 'button',
                      style: { ...S.action, marginTop: 0, color: T.text },
                      onClick: () => openMemory(row.id),
                    },
                    '打开这条',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: { ...S.action, marginTop: 0, color: T.dim },
                      onClick: () => ignoreLint(row.id),
                    },
                    '忽略这条',
                  ),
                ),
              ),
            ),
            (lint.rows ?? []).length > lintLimit
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: { ...S.action, marginTop: 8, color: T.text },
                    onClick: () => setLintLimit(lintLimit + 12),
                  },
                  `显示更多（还有 ${(lint.rows ?? []).length - lintLimit} 条）`,
                )
              : null,
          )
        : null;

      const reviewView = review
        ? h(
            'div',
            null,
            lintSummary,
            h(
              'div',
              { style: S.section },
              h(
                'div',
                { style: S.sectionTitle },
                `体检：扫了 ${review.scanned ?? 0} 条，待处理 ${
                  (review.counts?.stale ?? 0) +
                    (review.counts?.unused ?? 0) +
                    (review.counts?.merge ?? 0) +
                    (review.counts?.noEvidence ?? 0) +
                    (review.counts?.expired ?? 0)
                } 条`,
              ),
              h(
                'div',
                { style: S.reviewWhy },
                '只出单子，不自动改。「忽略」记在 .dsh-memory/review-ignored.json，清掉就能重新出现。',
              ),
              h(
                'div',
                { style: S.reviewWhy },
                '「可能没用」只列待确认的候选：点「留着」确认过的、或设了过期日的，会从这张单子上消失。',
              ),
              reviewNote ? h('div', { style: { ...S.reviewWhy, color: T.accent } }, reviewNote) : null,
              error ? h('div', { style: { ...S.reviewWhy, color: T.danger } }, error) : null,
            ),
            reviewGroup('疑似过时', review.stale ?? [], 'stale'),
            reviewGroup('可能没用', review.unused ?? [], 'unused'),
            reviewGroup('已确认没写出处', review.noEvidence ?? [], 'noev'),
            reviewGroup('已过期', review.expired ?? [], 'expired'),
            reviewGroup('可以合并', review.merge ?? [], 'merge'),
            reviewGroup(
              '已忽略',
              (review.ignoredEntries ?? []).map((entry) => ({
                ...entry,
                fromIgnored: true,
                why:
                  entry.action === 'kept'
                    ? '你点过「留着」或「30 天后过期」，从体检单上移走了'
                    : '你点过「忽略」，不再出现在上面几张单子里',
              })),
              'ignored',
            ),
          )
        : h('div', { style: S.empty }, busy ? '读体检单…' : '还没有体检数据，点上面的 ↻ 刷新');

      if (!isOpen) return null;
      const lastInject = state?.lastInject ?? null;
      const entries = state?.index?.entries ?? [];
      const recent = [...entries]
        .filter((entry) => entry.updated)
        .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
        .slice(0, 5);
      const budget = state?.budget ?? lastInject?.chars?.budget ?? 4000;
      const digest = state?.digest ?? null;
      const today = state?.today ?? { date: '', lines: [] };

      const l0 = lastInject?.l0 ?? [];
      const l1 = lastInject?.l1 ?? [];
      const l0Chars = lastInject?.chars?.l0 ?? 0;
      const l1Chars = lastInject?.chars?.l1 ?? 0;
      const statusCounts = entries.reduce((acc, entry) => {
        const key = entry.status ?? 'verified';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      const usedChars = l0Chars + l1Chars;
      const usedPct = budget ? Math.min(100, Math.round((usedChars / budget) * 100)) : 0;

      const statusEntries = statusView
        ? entries.filter((entry) => (entry.status ?? 'verified') === statusView)
        : [];

      // 详情卡片：单独抽出来，「全部」页要把它放在右栏，其它页还是在正文里铺开。
      const detailCard = detail
              ? h(
                  'div',
                  null,
                  h('div', { style: S.detailTitle }, detail.title),
                  h(
                    'div',
                    { style: S.detailMeta },
                    `${typeLabel(detail.type)} · ${STATUS_LABEL[detail.status] ?? detail.status} · 更新 ${detail.updated || '—'}` +
                      (detail.expires ? ` · 过期 ${detail.expires}` : '') +
                      ` · 读过 ${detail.reads ?? 0} 次`,
                  ),
                  detail.evidence
                    ? h('div', { style: S.detailMeta }, `出处：${detail.evidence}`)
                    : null,
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } },
                    h(
                      'button',
                      { type: 'button', style: S.action, onClick: () => findEvidenceFor(detail.id), disabled: evidenceBusy },
                      evidenceBusy ? '翻会话中…' : '找出处（翻会话存档）',
                    ),
                    detail.evidence
                      ? h('button', { type: 'button', style: S.action, onClick: () => writeEvidence(''), disabled: busy }, '清空出处')
                      : null,
                    evidenceNote ? h('span', { style: { fontSize: 11, color: T.faint } }, evidenceNote) : null,
                  ),
                  evidenceList && evidenceList.length
                    ? h(
                        'div',
                        { style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 } },
                        evidenceList.map((candidate) =>
                          h(
                            'div',
                            {
                              key: `${candidate.sessionId}-${candidate.at}`,
                              // 用 div 不用 button：button 有固定行高，长原话换行会溢出到正文上（叠字）。
                              style: {
                                padding: '5px 8px',
                                borderRadius: 6,
                                cursor: 'pointer',
                                fontSize: 12,
                                lineHeight: 1.55,
                                whiteSpace: 'normal',
                                wordBreak: 'break-word',
                                color: T.text,
                                background: 'rgba(255,255,255,0.05)',
                                border: `1px solid ${T.border}`,
                              },
                              title: '点这条就把它写成这条记忆的出处',
                              onClick: () => applyEvidence(candidate),
                            },
                            `${String(candidate.at).slice(0, 10)} · ${String(candidate.quote).slice(0, 70)}`,
                          ),
                        ),
                      )
                    : null,
                  h('pre', { style: S.pre }, detail.text),
                  editing
                    ? h(
                        'div',
                        { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' } },
                        h('input', { style: S.input, value: editing.title, onChange: (event) => setEditing({ ...editing, title: event.target.value }) }),
                        h('textarea', {
                          style: { ...S.input, height: 'auto', minHeight: '130px', padding: '8px 9px', lineHeight: 1.6 },
                          value: editing.content,
                          onChange: (event) => setEditing({ ...editing, content: event.target.value }),
                        }),
                        h('input', { style: S.input, value: editing.tags, placeholder: '标签，空格或逗号分隔', onChange: (event) => setEditing({ ...editing, tags: event.target.value }) }),
                        h('input', { style: S.input, value: editing.importance, placeholder: '重要度 0–100', onChange: (event) => setEditing({ ...editing, importance: event.target.value }) }),
                        h(
                          'div',
                          null,
                          h('button', { type: 'button', style: S.action, onClick: saveEdit, disabled: busy }, '保存'),
                          h('button', { type: 'button', style: { ...S.action, color: T.faint, marginLeft: '8px' }, onClick: () => setEditing(null) }, '取消'),
                        ),
                      )
                    : null,
                  related.length
                    ? h(
                        'div',
                        { style: { ...S.detailMeta, marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' } },
                        '关联：',
                        related.map((item) =>
                          h(
                            'button',
                            {
                              key: item.id,
                              type: 'button',
                              style: { ...S.action, marginTop: 0, height: '22px', padding: '0 8px', fontSize: '11px' },
                              title: item.kind,
                              onClick: () => openMemory(item.id),
                            },
                            item.title,
                          ),
                        ),
                      )
                    : null,
                  h(
                    'div',
                    null,
                    h(
                      'button',
                      {
                        type: 'button',
                        style: S.action,
                        title: '确认为真（人给的章）：L1 按线索能检索到；要每轮都带，再点「每轮都带（进 L0）」',
                        onClick: () => setStatus(detail.id, 'verified'),
                        disabled: busy || detail.status === 'verified',
                      },
                      detail.status === 'verified' ? '已确认' : '设为已确认',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...S.action, marginLeft: '8px', color: detail.pinned ? T.accent : T.dim },
                        title:
                          '每轮都带（只对「已确认 + 决策/偏好」生效）。不进 L0 的记忆仍会被 L1 按线索检索到。',
                        onClick: () => setPinned(detail.id, !detail.pinned),
                        disabled: busy,
                      },
                      detail.pinned ? '取消每轮注入' : '每轮都带（进 L0）',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...S.action, color: T.faint, marginLeft: '8px' },
                        title: '有争议：不进 L0/L1，等核对',
                        onClick: () => setStatus(detail.id, 'disputed'),
                        disabled: busy || detail.status === 'disputed',
                      },
                      detail.status === 'disputed' ? '有争议' : '标为有争议',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: S.action,
                        title: '只改 frontmatter 的 status 字段，文件保留',
                        onClick: () => supersede(detail.id),
                        disabled: busy || detail.status === 'superseded',
                      },
                      detail.status === 'superseded' ? '已废弃' : '标为已废弃',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...S.action, color: T.faint, marginLeft: '8px' },
                        title: '关掉这个面板，在左栏「记忆星图」里把它点亮',
                        onClick: () => {
                          if (detail?.id) requestGraphFocus(detail.id);
                          setOpen(false);
                        },
                      },
                      '在图里高亮',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...S.action, color: T.faint, marginLeft: '8px' },
                        title: '把这条的正文复制到剪贴板',
                        onClick: copyText,
                      },
                      copyHint || '复制正文',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...S.action, color: T.dim, marginLeft: '8px' },
                        onClick: () => {
                          setEditing({
                            title: detail.title ?? '',
                            content: detail.text ?? '',
                            tags: (detail.tags ?? []).join(' '),
                            importance: String(detail.importance ?? ''),
                          });
                        },
                      },
                      '编辑',
                    ),
                    confirmDelete
                      ? h(
                          'button',
                          { type: 'button', style: { ...S.action, color: T.danger, marginLeft: '8px' }, onClick: doDelete, disabled: busy },
                          '确认归档（移到 Archive，可恢复）',
                        )
                      : h(
                          'button',
                          { type: 'button', style: { ...S.action, color: T.faint, marginLeft: '8px' }, onClick: () => setConfirmDelete(true) },
                          '归档',
                        ),
                    h(
                      'button',
                      { type: 'button', style: { ...S.action, color: T.faint, marginLeft: '8px' }, onClick: () => setDetail(null) },
                      '返回',
                    ),
                  ),
                )
        : null;

      // 「全部」页：搜索（防抖后）+ 排序 + 分页，一页 20 条。数据来自索引，不读文件。
      const PAGE_SIZE = 20;
      const loweredQuery = debouncedQuery.toLowerCase();
      const pagesEntries = entries
        .filter((entry) => {
          if (!loweredQuery) return true;
          const hay = `${entry.title ?? ''} ${(entry.tags ?? []).join(' ')}`.toLowerCase();
          return hay.includes(loweredQuery);
        })
        .slice();
      const sorters = {
        recent: (a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')),
        oldest: (a, b) => String(a.updated ?? '').localeCompare(String(b.updated ?? '')),
        reads: (a, b) =>
          (b.reads ?? 0) - (a.reads ?? 0) || String(b.updated ?? '').localeCompare(String(a.updated ?? '')),
        expiring: (a, b) => String(a.expires || '9999-99-99').localeCompare(String(b.expires || '9999-99-99')),
      };
      pagesEntries.sort(sorters[sortBy] ?? sorters.recent);
      const pageCount = Math.max(1, Math.ceil(pagesEntries.length / PAGE_SIZE));
      const safePage = Math.min(Math.max(0, pageIndex), pageCount - 1);
      const pageEntries = pagesEntries.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

      const sortButton = (key, label) =>
        h(
          'button',
          {
            key,
            type: 'button',
            style: {
              ...S.iconButton,
              width: 'auto',
              padding: '0 6px',
              color: sortBy === key ? T.text : T.faint,
            },
            onClick: () => {
              setSortBy(key);
              setPageIndex(0);
            },
          },
          label,
        );

      const pagesList = h(
        'div',
        { style: { flex: '1 1 44%', minWidth: 0 } },
        h(
          'div',
          { style: S.overviewRow },
          h('input', {
            type: 'search',
            value: query,
            placeholder: '搜标题或标签…',
            style: {
              flex: 1,
              background: 'rgba(255,255,255,0.06)',
              border: `1px solid ${T.border}`,
              borderRadius: 6,
              color: T.text,
              padding: '6px 8px',
              fontSize: 12,
              outline: 'none',
            },
            onChange: (event) => {
              setQuery(event.target.value);
              setPageIndex(0);
            },
          }),
          h('span', { style: S.statHint }, `${pagesEntries.length} 条`),
        ),
        h('div', { style: { ...S.overviewRow, marginTop: 6 } },
          sortButton('recent', '最近更新'),
          sortButton('oldest', '最久没动'),
          sortButton('reads', '读得最多'),
          sortButton('expiring', '快过期'),
        ),
        pageEntries.length
          ? pageEntries.map((entry) =>
              h(
                'div',
                { key: entry.id, style: { ...S.row, flexDirection: 'column', alignItems: 'stretch', gap: 2 }, onClick: () => openMemory(entry.id), title: entry.title },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
                  h('span', { style: S.tag }, typeLabel(entry.type)),
                  h('span', { style: S.rowTitle }, entry.title),
                ),
                h('span', { style: S.rowMetaLine }, `${entry.reads ?? 0} 读 · ${entry.updated || '—'}`),
              ),
            )
          : h('div', { style: S.empty }, debouncedQuery ? '没搜到' : '库里还没有记忆'),
        pageCount > 1
          ? h(
              'div',
              { style: { ...S.overviewRow, marginTop: 8 } },
              h(
                'button',
                { type: 'button', style: S.iconButton, title: '上一页', disabled: safePage <= 0, onClick: () => setPageIndex(safePage - 1) },
                '‹',
              ),
              h('span', { style: S.statHint }, `第 ${safePage + 1} / ${pageCount} 页`),
              h(
                'button',
                {
                  type: 'button',
                  style: S.iconButton,
                  title: '下一页',
                  disabled: safePage >= pageCount - 1,
                  onClick: () => setPageIndex(safePage + 1),
                },
                '›',
              ),
            )
          : null,
      );

      // 左列表、右详情：点条目不再把列表顶掉，能对照着看。
      const pagesView = h(
        'div',
        { style: { display: 'flex', gap: 12, alignItems: 'flex-start' } },
        pagesList,
        h(
          'div',
          {
            style: {
              flex: '1 1 56%',
              minWidth: 0,
              maxHeight: '66vh',
              overflow: 'auto',
              borderLeft: `1px solid ${T.border}`,
              paddingLeft: 12,
            },
          },
          detailCard ?? h('div', { style: S.empty }, '点左边一条看全文'),
        ),
      );

      const row = (memory, extra) =>
        h(
          'div',
          {
            key: memory.id,
            style: { ...S.row, flexDirection: 'column', alignItems: 'stretch', gap: 2 },
            onClick: () => openMemory(memory.id),
            title: memory.title,
          },
          h('span', { style: S.tag }, `[${typeLabel(memory.type)}${memory.importance != null ? `·${memory.importance}` : ''}]`),
          h('span', { style: S.rowTitle }, memory.title),
          extra ? h('span', { style: S.rowMeta }, extra) : null,
        );

      return h(
        'div',
        { style: S.overlay, onClick: (event) => { if (event.target === event.currentTarget) setOpen(false); } },
        h(
          'div',
          { style: S.panel },
          h(
            'div',
            { style: S.header },
            h(
              'span',
              { style: S.title },
              view === 'review' ? '记忆 · 体检' : view === 'pages' ? '记忆 · 全部' : '记忆 · 这一轮带了什么',
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.iconButton, width: 'auto', padding: '0 8px', color: view === 'round' ? T.text : T.faint },
                title: '这一轮带进来的记忆',
                onClick: () => setView('round'),
              },
              '这一轮',
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.iconButton, width: 'auto', padding: '0 8px', color: view === 'review' ? T.text : T.faint },
                title: '体检单：过时 / 没用 / 可合并 / 没出处',
                onClick: () => {
                  setView('review');
                  loadReview();
                  loadLint();
                },
              },
              '体检',
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.iconButton, width: 'auto', padding: '0 8px', color: view === 'pages' ? T.text : T.faint },
                title: '全部记忆：搜索、筛选、排序',
                onClick: () => {
                  setDetail(null);
                  setStatusView('');
                  setView('pages');
                },
              },
              '全部',
            ),
            h('button', { type: 'button', style: S.iconButton, title: '刷新当前页', onClick: reloadCurrent, disabled: busy }, '↻'),
            h('button', { type: 'button', style: S.iconButton, title: '关闭', onClick: () => setOpen(false) }, '×'),
          ),
          h(
            'div',
            { style: S.body },
            error ? h('div', { style: S.error }, error) : null,
            refreshedAt ? h('div', { style: { fontSize: 11, color: T.faint, marginBottom: 6 } }, `已刷新 ${refreshedAt}`) : null,

            !detail && view === 'round' && entries.length
              ? h(
                  'div',
                  { style: S.overview },
                  h(
                    'div',
                    { style: S.overviewRow },
                    h('span', { style: S.stat }, String(entries.length)),
                    h('span', { style: S.statHint }, '条记忆'),
                    h('span', { style: { flex: 1 } }),
                    ['verified', 'candidate', 'disputed', 'superseded'].map((status) =>
                      h(
                        'button',
                        {
                          key: status,
                          type: 'button',
                          style: {
                            ...S.statusChip,
                            cursor: 'pointer',
                            border: 'none',
                            background: statusView === status ? T.accentSoft : 'transparent',
                            borderRadius: 5,
                            padding: '2px 5px',
                          },
                          title: `点开看「${STATUS_LABEL[status]}」的 ${statusCounts[status] ?? 0} 条`,
                          onClick: () => {
                            setDetail(null);
                            setStatusView(statusView === status ? '' : status);
                          },
                        },
                        h('span', {
                          style: { ...S.dot, background: `rgba(${STATUS_COLORS[status]},0.95)` },
                        }),
                        `${STATUS_LABEL[status]} ${statusCounts[status] ?? 0}`,
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { style: S.overviewRow },
                    h('span', { style: S.statHint }, `注入 ${usedChars} / ${budget} 字`),
                    h('span', { style: { flex: 1 } }),
                    h('span', { style: S.statHint }, `${usedPct}%`),
                  ),
                  h(
                    'div',
                    { style: S.barTrack },
                    h('div', { style: { ...S.barFill, width: `${usedPct}%` } }),
                  ),
                  digest && digest.lastResult === 'failed'
                    ? h(
                        'div',
                        { style: S.digestFail },
                        h(
                          'span',
                          { style: { flex: 1 } },
                          `上次收盘没跑成${digest.lastRunAt ? `（${timeLabel(digest.lastRunAt)}）` : ''}：${digest.lastError || '原因没记下来'}`,
                        ),
                        h(
                          'button',
                          { type: 'button', style: { ...S.action, marginTop: 0, marginLeft: 0, color: T.text, flexShrink: 0 }, onClick: runDigest, disabled: busy },
                          busy ? '重跑中…' : '重跑收盘',
                        ),
                      )
                    : null,
                )
              : null,

            detail && view !== 'pages'
              ? detailCard
              : view === 'pages'
                ? pagesView
                : view === 'review'
                  ? reviewView
                : statusView
                  ? h(
                      'div',
                      { style: S.section },
                      h(
                        'div',
                        { style: S.sectionTitle },
                        `${STATUS_LABEL[statusView]} · ${statusEntries.length} 条`,
                        h('span', { style: { color: T.faint, fontWeight: 400 } }, '点一行看全文'),
                      ),
                      statusEntries.length
                        ? statusEntries.map((entry) =>
                            h(
                              'div',
                              {
                                key: entry.id,
                                style: S.row,
                                onClick: () => openMemory(entry.id),
                                title: entry.title,
                              },
                              h('span', { style: S.tag }, typeLabel(entry.type)),
                              h('span', { style: S.rowTitle }, entry.title),
                              h('span', { style: S.rowMeta }, timeLabel(entry.updated)),
                            ),
                          )
                        : h('div', { style: S.empty }, '没有'),
                      h(
                        'button',
                        {
                          type: 'button',
                          style: { ...S.action, marginTop: '10px', color: T.faint },
                          onClick: () => setStatusView(''),
                        },
                        '返回这一轮',
                      ),
                    )
                  : h(
                  'div',
                  null,
                  h(
                    'div',
                    { style: S.section },
                    h(
                      'div',
                      { style: S.sectionTitle },
                      `L0 ${l0.length} 条 · 全量注入`,
                      h('span', { style: { color: T.faint, fontWeight: 400 } }, `约 ${l0Chars} 字`),
                    ),
                    l0.length
                      ? l0.map((memory) => row(memory, memory.chars != null ? `${memory.chars} 字` : ''))
                      : h('div', { style: S.empty }, '这轮没有 L0（没有同时 pinned 且为 decision/preference 的条目）'),
                  ),
                  h(
                    'div',
                    { style: S.section },
                    h(
                      'div',
                      { style: S.sectionTitle },
                      `L1 ${l1.length} 条 · 按线索检索`,
                      h('span', { style: { color: T.faint, fontWeight: 400 } }, `约 ${l1Chars} 字`),
                    ),
                    l1.length
                      ? l1.map((memory) =>
                          h(
                            'div',
                            { key: memory.id, style: S.row, onClick: () => openMemory(memory.id), title: memory.title },
                            h('span', { style: S.tag }, `[${typeLabel(memory.type)}]`),
                            h(
                              'span',
                              { style: S.rowTitle },
                              memory.title,
                              memory.matched && memory.matched.length
                                ? h('span', { style: S.hit }, `命中：${memory.matched.join('、')}`)
                                : h('span', { style: S.hit }, `命中 ${memory.hits ?? 0} 个线索`),
                            ),
                          ),
                        )
                      : h('div', { style: S.empty }, '这轮没命中（线索词不够或都不够贴）'),
                  ),
                  h(
                    'div',
                    { style: S.section },
                    h('div', { style: S.sectionTitle }, '最近写入'),
                    recent.length
                      ? recent.map((entry) =>
                          h(
                            'div',
                            { key: entry.id, style: { ...S.row, flexDirection: 'column', alignItems: 'stretch', gap: 2 }, onClick: () => openMemory(entry.id), title: entry.title },
                            h(
                              'div',
                              { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
                              h('span', { style: S.tag }, timeLabel(entry.updated)),
                              h('span', { style: S.rowTitle }, entry.title),
                            ),
                            h('span', { style: S.rowMetaLine }, typeLabel(entry.type)),
                          ),
                        )
                      : h('div', { style: S.empty }, '还没有写入'),
                  ),
                ),
                h(
                  'div',
                  { style: S.section },
                  h(
                    'div',
                    { style: S.sectionTitle },
                    `今天流水${today?.date ? ` · ${today.date}` : ''}`,
                  ),
                  today?.lines?.length
                    ? today.lines.map((line, index) =>
                        h(
                          'div',
                          { key: `${line.time}-${index}`, style: S.row },
                          h('span', { style: S.tag }, line.time),
                          line.by && line.by !== '家里'
                            ? h('span', { style: S.byTag }, line.by)
                            : null,
                          h('span', { style: S.rowTitle }, line.text),
                        ),
                      )
                    : h('div', { style: S.empty }, '今天还没有流水'),
                ),
          ),
          h(
            'div',
            { style: S.footer },
            h('span', null, `注入实算 ${l0Chars + l1Chars} 字 / 预算 ${budget}`),
            h('span', { style: { flex: 1 } }),
            lastInject?.at ? h('span', null, `快照 ${timeLabel(lastInject.at)}`) : null,
          ),
        ),
      );
    }

    // 四态的人话与颜色（面板顶部概览用）
    const STATUS_LABEL = { verified: '已确认', candidate: '待确认', disputed: '有争议', superseded: '已废弃' };
    // 类型的显示名。开源时要变成可配置的（配置里给 label，这本字典只是默认）。
    const SUGGEST_LABEL = { supersede: '标为已废弃', evidence: '补出处', demote: '降为候选', renew: '续期', merge: '合并' };

const TYPE_LABEL = {
      decision: '决策',
      preference: '偏好',
      experience: '经验',
      knowledge: '知识',
      'project-state': '项目状态',
      profile: '画像',
    };
    const typeLabel = (type) => TYPE_LABEL[type] ?? type ?? '';    const STATUS_COLORS = {
      verified: '120,200,160',
      candidate: '235,190,120',
      disputed: '240,140,140',
      superseded: '140,150,170',
    };

    // ---- 记忆星图（侧边栏 tab，dsh-better-sidebar 的 tab 类型） ----
    //
    // 节点=一条记忆，连线=线索关联（同一 tag / 标题词重合）。
    // 布局自己算（斥力 + 弹簧 + 向心，迭代退火），坐标归一化到 0..1，
    // 所以窗口大小变化时只重绘、不重算布局。
    const TYPE_COLORS = {
      decision: '120,180,255',
      preference: '140,220,180',
      experience: '235,190,120',
      knowledge: '170,150,240',
      'project-state': '110,200,230',
      profile: '240,160,200',
    };

    function nodeColor(type, alpha) {
      return `rgba(${TYPE_COLORS[type] ?? '180,190,210'},${alpha})`;
    }

    function hashSeed(text) {
      let seed = 2166136261;
      for (const ch of String(text)) {
        seed ^= ch.charCodeAt(0);
        seed = Math.imul(seed, 16777619) >>> 0;
      }
      return seed >>> 0;
    }

    function makeRandom(seed) {
      let state = seed >>> 0;
      return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
    }

    function computeLayout(graph) {
      if (!graph?.nodes?.length) return [];
      const random = makeRandom(20261123);
      const nodes = graph.nodes.map((node) => {
        const angle = random() * Math.PI * 2;
        const radius = Math.sqrt(random()) * 0.3;
        return {
          ...node,
          x: 0.5 + Math.cos(angle) * radius,
          y: 0.5 + Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
        };
      });
      const indexOf = new Map(nodes.map((node, i) => [node.id, i]));
      const edges = graph.edges
        .map((edge) => ({ ...edge, a: indexOf.get(edge.source), b: indexOf.get(edge.target) }))
        .filter((edge) => edge.a !== undefined && edge.b !== undefined);

      // 按类型分团：每种 type 一个锚点，节点被轻轻拉向自己那一团（第三层视觉）。
      const typeList = [...new Set(nodes.map((node) => node.type))].sort();
      const anchors = new Map(
        typeList.map((type, i) => {
          const angle = (i / Math.max(1, typeList.length)) * Math.PI * 2 - Math.PI / 2;
          return [type, { x: 0.5 + Math.cos(angle) * 0.26, y: 0.5 + Math.sin(angle) * 0.26 }];
        }),
      );

      const count = nodes.length;
      const iterations = count > 120 ? 120 : 200;
      const repulsion = 0.0009;
      const spring = 0.02;
      const gravity = 0.0012;

      for (let step = 0; step < iterations; step += 1) {
        const cooling = 1 - step / iterations;
        for (let i = 0; i < count; i += 1) {
          const p = nodes[i];
          for (let j = i + 1; j < count; j += 1) {
            const q = nodes[j];
            let dx = p.x - q.x;
            let dy = p.y - q.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1e-8) {
              dx = (random() - 0.5) * 0.002;
              dy = (random() - 0.5) * 0.002;
              d2 = dx * dx + dy * dy;
            }
            const distance = Math.sqrt(d2);
            const force = Math.min(0.004, repulsion / d2);
            const fx = (dx / distance) * force;
            const fy = (dy / distance) * force;
            p.vx += fx;
            p.vy += fy;
            q.vx -= fx;
            q.vy -= fy;
          }
        }
        for (const edge of edges) {
          const p = nodes[edge.a];
          const q = nodes[edge.b];
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const distance = Math.hypot(dx, dy) || 1e-6;
          const target = 0.07 + 0.015 * Math.log2(1 + (edge.weight ?? 1));
          const force = spring * (distance - target) * cooling;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          p.vx += fx;
          p.vy += fy;
          q.vx -= fx;
          q.vy -= fy;
        }
        for (const node of nodes) {
          const anchor = anchors.get(node.type);
          if (anchor) {
            node.vx += (anchor.x - node.x) * 0.008 * cooling;
            node.vy += (anchor.y - node.y) * 0.008 * cooling;
          }
          node.vx += (0.5 - node.x) * gravity * cooling;
          node.vy += (0.5 - node.y) * gravity * cooling;
          const step = Math.max(-0.02, Math.min(0.02, node.vx));
          const stepY = Math.max(-0.02, Math.min(0.02, node.vy));
          node.x += step;
          node.y += stepY;
          node.vx *= 0.82;
          node.vy *= 0.82;
        }
      }

      // 归一化到留边 0.07..0.93（保留一点空白，节点圆不被裁）
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const node of nodes) {
        minX = Math.min(minX, node.x);
        maxX = Math.max(maxX, node.x);
        minY = Math.min(minY, node.y);
        maxY = Math.max(maxY, node.y);
      }
      const spanX = Math.max(1e-6, maxX - minX);
      const spanY = Math.max(1e-6, maxY - minY);
      for (const node of nodes) {
        node.x = 0.07 + ((node.x - minX) / spanX) * 0.86;
        node.y = 0.07 + ((node.y - minY) / spanY) * 0.86;
      }
      return nodes;
    }

    // 半径以「重要性」为主：importance 100 约 15px，importance 50 约 10px，importance 0 约 3px；
    // 读过/命中只做小加成（它们是「用过」，不是「重要」）。
    function nodeRadius(node) {
      const importance = Math.max(0, Math.min(100, Number(node.importance) || 0));
      const base = 3 + Math.pow(importance / 100, 0.8) * 12;
      const used = Math.min(3, (node.reads ?? 0) * 0.4 + (node.hits ?? 0) * 0.3);
      return base + used + (node.pinned ? 2.5 : 0);
    }

    function GraphTab() {
      const [graph, setGraph] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [showAll, setShowAll] = React.useState(false);
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [detailBusy, setDetailBusy] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [hoverNode, setHoverNode] = React.useState(null);
      const [hiddenTypes, setHiddenTypes] = React.useState(() => new Set());
      const focusRequestValue = useGraphFocus();
      const [highlightId, setHighlightId] = useState('');
      const panRef = React.useRef({ x: 0, y: 0 });
      const dragRef = React.useRef(null);
      const movedRef = React.useRef(false);
      const [panning, setPanning] = React.useState(false);
      const [menu, setMenu] = React.useState(null);
      const canvasRef = React.useRef(null);
      const layoutRef = React.useRef([]);
      const hoverRef = React.useRef(null);
      const frameRef = React.useRef(0);

      const load = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
          const data = await request(`/graph${showAll ? '?all=1' : ''}`);
          const nodes = computeLayout(data);
          layoutRef.current = nodes;
          setGraph({ ...data, nodes });
          setSelected(null);
          setDetail(null);
        } catch (failure) {
          setError(failure.message ?? String(failure));
        } finally {
          setBusy(false);
        }
      }, [showAll]);

      useEffect(() => {
        void load();
      }, [load]);

      // 面板里点「在图里高亮」：等图就绪后选中它并亮 2.6 秒
      useEffect(() => {
        const id = focusRequestValue?.id;
        if (!id || !graph) return;
        if (!graph.nodes.some((node) => node.id === id)) return;
        setSelected(id);
        setHighlightId(id);
        const timer = setTimeout(() => setHighlightId(''), 2600);
        return () => clearTimeout(timer);
      }, [focusRequestValue, graph]);

      const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const width = canvas.clientWidth || 640;
        const height = canvas.clientHeight || 480;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
        }
        const surface = canvas.getContext('2d');
        if (!surface) return;
        surface.setTransform(dpr, 0, 0, dpr, 0, 0);
        surface.clearRect(0, 0, width, height);

        // 深空底：中心一点冷光、四周压暗，再撒一层固定星点（seed 固定，不闪）。
        const backdrop = surface.createRadialGradient(
          width * 0.5,
          height * 0.4,
          Math.min(width, height) * 0.05,
          width * 0.5,
          height * 0.5,
          Math.max(width, height) * 0.78,
        );
        backdrop.addColorStop(0, 'rgba(30,42,70,0.92)');
        backdrop.addColorStop(0.5, 'rgba(15,19,31,0.96)');
        backdrop.addColorStop(1, 'rgba(7,9,15,1)');
        surface.fillStyle = backdrop;
        surface.fillRect(0, 0, width, height);
        const stars = makeRandom(20261124);
        for (let i = 0; i < 240; i += 1) {
          const sx = stars() * width;
          const sy = stars() * height;
          const size = 0.4 + stars() * 1.1;
          surface.fillStyle = `rgba(206,220,255,${0.05 + stars() * 0.22})`;
          surface.beginPath();
          surface.arc(sx, sy, size, 0, Math.PI * 2);
          surface.fill();
        }

        const nodes = layoutRef.current;
        const edges = graph?.edges ?? [];
        const hidden = hiddenTypes;
        const visible = (node) => !hidden.has(node.type);
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const focus = selected ?? hoverRef.current;
        const focused = focus ? byId.get(focus) : null;
        const neighborIds = new Set();
        if (focused) {
          for (const edge of edges) {
            if (edge.source === focus) neighborIds.add(edge.target);
            if (edge.target === focus) neighborIds.add(edge.source);
          }
        }
        const needle = query.trim().toLowerCase();
        const matches = (node) =>
          !needle ||
          String(node.title).toLowerCase().includes(needle) ||
          node.tags.some((tag) => String(tag).toLowerCase().includes(needle));

        const pan = panRef.current;
        const at = (x, y) => [x * width + pan.x, y * height + pan.y];

        // 连线
        for (const edge of edges) {
          const a = byId.get(edge.source);
          const b = byId.get(edge.target);
          if (!a || !b || !visible(a) || !visible(b)) continue;
          const touched = focused && (edge.source === focus || edge.target === focus);
          surface.strokeStyle = touched
            ? 'rgba(120,180,255,0.55)'
            : `rgba(255,255,255,${0.035 + 0.025 * Math.min(9, edge.weight ?? 1)})`;
          surface.lineWidth = touched ? 1.4 : 0.7;
          surface.beginPath();
          surface.moveTo(...at(a.x, a.y));
          surface.lineTo(...at(b.x, b.y));
          surface.stroke();
        }

        // 节点
        for (const node of nodes) {
          if (!visible(node)) continue;
          const [px, py] = at(node.x, node.y);
          const radius = nodeRadius(node);
          const isFocus = focus === node.id;
          const isNeighbor = neighborIds.has(node.id);
          const dim = (focused && !isFocus && !isNeighbor) || (needle && !matches(node));
          const alpha = dim ? 0.16 : 0.92;

          if (node.id === highlightId) {
            for (const ring of [10, 16, 23]) {
              surface.beginPath();
              surface.arc(px, py, radius + ring, 0, Math.PI * 2);
              surface.strokeStyle = `rgba(120,180,255,${0.34 - ring * 0.01})`;
              surface.lineWidth = 1.4;
              surface.stroke();
            }
          }
          if (node.pinned) {
            surface.beginPath();
            surface.arc(px, py, radius + 3.5, 0, Math.PI * 2);
            surface.fillStyle = 'rgba(120,180,255,0.10)';
            surface.fill();
          }
          surface.save();
          surface.shadowBlur = dim ? 0 : isFocus ? 20 : 9;
          surface.shadowColor = nodeColor(node.type, dim ? 0 : 0.9);
          surface.beginPath();
          surface.arc(px, py, radius, 0, Math.PI * 2);
          surface.fillStyle = nodeColor(node.type, alpha);
          surface.fill();
          surface.restore();
          surface.beginPath();
          surface.arc(px, py, radius, 0, Math.PI * 2);
          surface.lineWidth = isFocus ? 2 : 0.8;
          surface.strokeStyle = isFocus ? 'rgba(255,255,255,0.95)' : 'rgba(10,12,18,0.55)';
          surface.stroke();
        }

        // 标签：只画选中的、悬停的，以及图上最重的 10 个，免得糊成一片
        surface.font = '11px system-ui, sans-serif';
        surface.textAlign = 'center';
        surface.textBaseline = 'top';
        const heavy = new Set(
          [...nodes].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, 10).map((node) => node.id),
        );
        for (const node of nodes) {
          if (!visible(node)) continue;
          if (!focused && !heavy.has(node.id)) continue;
          if (focused && !(node.id === focus || neighborIds.has(node.id))) continue;
          const [px, py] = at(node.x, node.y);
          const label = String(node.title).slice(0, 14);
          surface.fillStyle = 'rgba(236,238,245,0.86)';
          surface.fillText(label, px, py + nodeRadius(node) + 4);
        }
      }, [graph, selected, query, hiddenTypes, highlightId]);

      useEffect(() => {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = requestAnimationFrame(() => draw());
        return () => cancelAnimationFrame(frameRef.current);
      }, [draw]);

      useEffect(() => {
        const onResize = () => draw();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [draw]);

      // 类型被隐藏时，悬停高亮要一起清掉，否则「节点关了、卡片还在」。
      useEffect(() => {
        if (!hoverNode || !hiddenTypes.has(hoverNode.type)) return;
        hoverRef.current = null;
        setHoverNode(null);
      }, [hiddenTypes, hoverNode]);

      // 选中的节点所属类型被隐藏时，清掉选中与右侧详情。
      useEffect(() => {
        if (!selected) return;
        const node = layoutRef.current.find((item) => item.id === selected);
        if (!node || !hiddenTypes.has(node.type)) return;
        setSelected(null);
        setDetail(null);
      }, [hiddenTypes, selected]);

      React.useEffect(() => {
        const stop = () => {
          if (!dragRef.current) return;
          dragRef.current = null;
          setPanning(false);
        };
        window.addEventListener('mouseup', stop);
        return () => window.removeEventListener('mouseup', stop);
      }, []);

      const pick = (event) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        let best = null;
        let bestDistance = 16;
        for (const node of layoutRef.current) {
          if (hiddenTypes.has(node.type)) continue;
          const pan = panRef.current;
          const distance = Math.hypot(node.x * rect.width + pan.x - mx, node.y * rect.height + pan.y - my);
          if (distance < bestDistance) {
            best = node;
            bestDistance = distance;
          }
        }
        return best;
      };

      const openDetail = async (id) => {
        setDetailBusy(true);
        try {
          setDetail(await request(`/memory?id=${encodeURIComponent(id)}`));
        } catch (failure) {
          setDetail({ error: failure.message ?? String(failure) });
        } finally {
          setDetailBusy(false);
        }
      };

      const onMove = (event) => {
        const drag = dragRef.current;
        if (drag) {
          const dx = event.clientX - drag.sx;
          const dy = event.clientY - drag.sy;
          if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true;
          panRef.current = { x: drag.ox + dx, y: drag.oy + dy };
          cancelAnimationFrame(frameRef.current);
          frameRef.current = requestAnimationFrame(() => draw());
          return;
        }
        const hit = pick(event);
        const next = hit?.id ?? null;
        if (hoverRef.current === next) return;
        hoverRef.current = next;
        setHoverNode(hit ?? null);
        cancelAnimationFrame(frameRef.current);
        frameRef.current = requestAnimationFrame(() => draw());
      };

      const onClick = (event) => {
        if (movedRef.current) {
          movedRef.current = false;
          return;
        }
        const hit = pick(event);
        setMenu(null);
        const id = hit?.id ?? null;
        setSelected(id);
        setDetail(null);
        if (id) void openDetail(id);
      };

      const doAction = async (id, path, body) => {
        setMenu(null);
        try {
          await request(path, { method: 'POST', body: JSON.stringify({ id, ...body }) });
          await load();
        } catch (error) {
          setError(error?.message ?? String(error));
        }
      };

      const stats = graph?.stats;
      const summary = stats
        ? `${stats.nodes} 条 · ${stats.edges} 条连线 · ${stats.isolated} 个孤岛`
        : busy
          ? '正在算…'
          : '';
      const toggleType = (type) => {
        setHiddenTypes((previous) => {
          const next = new Set(previous);
          if (next.has(type)) next.delete(type);
          else next.add(type);
          return next;
        });
      };
      const emptyGraph = graph && (graph.nodes?.length ?? 0) === 0;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'rgba(16,18,24,0.6)', color: T.text } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid ' + T.divider, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 13, fontWeight: 600, letterSpacing: 0.3 } }, '记忆星图'),
          h('span', { style: { fontSize: 11, color: T.faint } }, summary),
          h('span', { style: { flex: 1 } }),
          h('input', {
            value: query,
            onChange: (event) => setQuery(event.target.value),
            placeholder: '搜标题 / 标签',
            style: {
              width: 120,
              height: 24,
              padding: '0 8px',
              borderRadius: 6,
              border: '1px solid ' + T.border,
              background: 'rgba(255,255,255,0.04)',
              color: T.text,
              fontSize: 11,
              outline: 'none',
            },
          }),
          h(
            'button',
            {
              type: 'button',
              onClick: () => setShowAll((value) => !value),
              style: { ...S.button, height: 24, fontSize: 11, opacity: showAll ? 1 : 0.7 },
              title: '把已废弃 / 有争议的也画出来',
            },
            showAll ? '含归档' : '只看在用',
          ),
          h('button', { type: 'button', onClick: () => void load(), style: { ...S.button, height: 24, fontSize: 11 }, title: '重新读取 vault 并重算布局' }, busy ? '…' : '重算'),
        ),
        // 图例：点一下按类型显隐，布局不动（不动会影响「一眼看结构」）
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderBottom: '1px solid ' + T.divider, flexWrap: 'wrap' } },
          Object.keys(TYPE_COLORS).map((type) =>
            h(
              'button',
              {
                key: type,
                type: 'button',
                onClick: () => toggleType(type),
                title: `${hiddenTypes.has(type) ? '显示' : '隐藏'} ${type}`,
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  border: 'none',
                  background: 'transparent',
                  color: hiddenTypes.has(type) ? T.faint : T.dim,
                  fontSize: 11,
                  cursor: 'pointer',
                  padding: 0,
                  opacity: hiddenTypes.has(type) ? 0.45 : 1,
                },
              },
              h('span', { style: { ...S.dot, width: 7, height: 7, background: nodeColor(type, 0.95) } }),
              typeLabel(type),
            ),
          ),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 10, color: T.faint } }, '点节点看全文 · 拖拽平移 · 双击复位 · 右键菜单'),
        ),
        error
          ? h('div', { style: { padding: 14, color: T.danger, fontSize: 12 } }, `读不到星图：${error}`)
          : h(
              'div',
              { style: { display: 'flex', flex: 1, minHeight: 0 } },
              h(
                'div',
                { style: { position: 'relative', flex: 1, minWidth: 0 } },
                h('canvas', {
                  ref: canvasRef,
                  onMouseDown: (event) => {
                    if (event.button !== 0) return;
                    movedRef.current = false;
                    dragRef.current = { sx: event.clientX, sy: event.clientY, ox: panRef.current.x, oy: panRef.current.y };
                    setPanning(true);
                  },
                  onDoubleClick: () => {
                    panRef.current = { x: 0, y: 0 };
                    setPanning(false);
                    cancelAnimationFrame(frameRef.current);
                    frameRef.current = requestAnimationFrame(() => draw());
                  },
                  onContextMenu: (event) => {
                    event.preventDefault();
                    const hit = pick(event);
                    setMenu(hit ? { id: hit.id, title: hit.title, pinned: Boolean(hit.pinned), x: event.clientX, y: event.clientY } : null);
                  },
                  onMouseMove: onMove,
                  onMouseLeave: () => {
                    hoverRef.current = null;
                    setHoverNode(null);
                    cancelAnimationFrame(frameRef.current);
                    frameRef.current = requestAnimationFrame(() => draw());
                  },
                  onClick,
                  style: { position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: panning ? 'grabbing' : hoverNode ? 'pointer' : 'grab' },
                }),
                menu
                  ? h(
                      'div',
                      {
                        style: {
                          position: 'fixed',
                          left: Math.min(menu.x, window.innerWidth - 190),
                          top: Math.min(menu.y, window.innerHeight - 160),
                          zIndex: 20,
                          minWidth: 168,
                          padding: '5px',
                          borderRadius: 8,
                          border: `1px solid ${T.border}`,
                          background: 'rgba(18,20,26,0.98)',
                          boxShadow: '0 12px 30px rgba(0,0,0,0.5)',
                          fontSize: 12,
                        },
                      },
                      h('div', { style: { padding: '4px 8px 6px', color: T.faint, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240 } }, String(menu.title ?? '').slice(0, 22)),
                      [
                        ['打开详情', () => { const id = menu.id; setMenu(null); void openDetail(id); setSelected(id); }],
                        ['设为已确认', () => doAction(menu.id, '/status', { status: 'verified' })],
                        [menu.pinned ? '取消每轮注入' : '每轮都带（进 L0）', () => doAction(menu.id, '/pin', { pinned: !menu.pinned })],
                        ['标为已废弃', () => doAction(menu.id, '/status', { status: 'superseded' })],
                        ['归档（可恢复）', () => doAction(menu.id, '/delete', { confirm: true })],
                      ].map(([label, run]) =>
                        h(
                          'button',
                          {
                            key: label,
                            type: 'button',
                            onClick: run,
                            style: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 9px', border: 'none', borderRadius: 5, background: 'transparent', color: label.includes('归档') ? T.danger : T.text, fontSize: 12, cursor: 'pointer' },
                          },
                          label,
                        ),
                      ),
                    )
                  : null,
                // hover 卡：跟着节点走，显示一眼能判断的信息
                hoverNode && !detail
                  ? h(
                      'div',
                      {
                        style: {
                          position: 'absolute',
                          left: `${hoverNode.x * 100}%`,
                          top: `${hoverNode.y * 100}%`,
                          transform: 'translate(-50%, -118%)',
                          pointerEvents: 'none',
                          maxWidth: 260,
                          padding: '6px 8px',
                          borderRadius: 8,
                          border: `1px solid ${T.border}`,
                          background: 'rgba(18,20,26,0.96)',
                          boxShadow: '0 10px 26px rgba(0,0,0,0.42)',
                          fontSize: 11,
                          lineHeight: 1.5,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        },
                      },
                      h('div', { style: { fontWeight: 600, marginBottom: 2 } }, String(hoverNode.title).slice(0, 40)),
                      h(
                        'div',
                        { style: { color: T.faint } },
                        `${typeLabel(hoverNode.type)} · 重要度 ${hoverNode.importance} · 读过 ${hoverNode.reads ?? 0} 次`,
                      ),
                    )
                  : null,
                emptyGraph
                  ? h(
                      'div',
                      {
                        style: {
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 18,
                        },
                      },
                      h(
                        'div',
                        {
                          style: {
                            maxWidth: 340,
                            padding: '14px 16px',
                            borderRadius: 10,
                            border: `1px solid ${T.border}`,
                            background: 'rgba(20,22,28,0.94)',
                            fontSize: 12,
                            lineHeight: 1.8,
                          },
                        },
                        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '星图还是空的'),
                        h('div', { style: { color: T.dim } }, '① 在对话里说「记一下……」，我会写进 vault'),
                        h('div', { style: { color: T.dim } }, '② 或者直接调 memory_write（一条一个文件）'),
                        h('div', { style: { color: T.dim } }, '③ 数据在 ~/.dsh/worlds/default/memory，改文件也生效'),
                      ),
                    )
                  : null,
                !graph && !busy
                  ? h(
                      'div',
                      { style: { ...S.empty, position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
                      '还没有记忆',
                    )
                  : null,
              ),
              // 右侧滑入详情：点节点就在这里看全文，不挤画布
              detail || detailBusy
                ? h(
                    'div',
                    {
                      style: {
                        width: 300,
                        flexShrink: 0,
                        borderLeft: '1px solid ' + T.divider,
                        overflow: 'auto',
                        padding: '10px 12px',
                        fontSize: 12,
                        lineHeight: 1.65,
                        background: 'rgba(20,22,28,0.92)',
                      },
                    },
                    detailBusy
                      ? h('span', { style: { color: T.dim } }, '读取全文…')
                      : detail?.error
                        ? h('span', { style: { color: T.danger } }, detail.error)
                        : h(
                            'div',
                            null,
                            h('div', { style: { fontWeight: 600, marginBottom: 4, fontSize: 13 } }, detail?.title),
                            h(
                              'div',
                              { style: { fontSize: 11, color: T.faint, marginBottom: 6 } },
                              `${typeLabel(detail?.type)} · ${STATUS_LABEL[detail?.status] ?? detail?.status} · 更新 ${detail?.updated ?? ''}` +
                                (detail?.expires ? ` · 过期 ${detail.expires}` : '') +
                                ` · 读过 ${detail?.reads ?? 0} 次`,
                            ),
                            detail?.evidence ? h('div', { style: { fontSize: 11, color: T.faint, marginBottom: 6 } }, `证据：${detail.evidence}`) : null,
                            h(
                              'pre',
                              { style: { margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: T.dim, fontSize: 12 } },
                              String(detail?.text ?? ''),
                            ),
                          ),
                  )
                : null,
            ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'memory-yuan',
              order: 20,
              label: '记忆',
            },
            MemoryButton,
          ),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'memory-yuan-panel',
              order: 30,
              label: '记忆面板',
            },
            MemoryPanel,
          ),
        );

        // 原生左栏入口（DSH 自带，不依赖第三方插件）：sidebar.panellist 放图标，
        // main 用同一个 key 放面板。写法照 DSH-memory-kr 的 dsh-memory-net/client.js。
        ctx.slots.inject('sidebar.panellist', () => {
          ctx.slots.register({ name: 'main', key: GRAPH_PANEL_ID, label: '记忆星图' }, GraphTab);
          ctx.slots.register(
            { name: 'sidebar.panellist', id: GRAPH_PANEL_ID, order: 25, label: () => '记忆星图' },
            (owner) => h(GraphIcon, { size: owner?.size ?? 18 }),
          );
        });

      },
    };
  },
});
