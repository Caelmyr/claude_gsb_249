/* 视图 10：历史记录与版本。 */
window.Views = window.Views || {};
window.Views.history = (function () {
  const C = window.Common;
  let current = null;

  return {
    mount(el) {
      el.innerHTML = `
        <div class="split">
          <div class="col" style="flex:1.6">
            <div class="panel">
              <div class="panel-title">处理历史<span class="dim">每条含当时的流水线快照（可恢复版本）</span></div>
              <div id="hi-list"></div>
            </div>
          </div>
          <div class="col">
            <div class="panel"><div class="panel-title">记录详情</div><div id="hi-detail"><div class="empty">选择左侧记录查看</div></div></div>
          </div>
        </div>`;
      // 预取节点定义，用于把快照里的类型标成「已不存在」
      C.fetchNodes().then((defs) => {
        C._nodesInfo = C._nodesInfo || {};
        defs.forEach((d) => { C._nodesInfo[d.type] = d; });
        if (current) renderDetail(el, current);
      });
      load(el);
    },
    refresh() { const el = document.querySelector('.view[data-view="history"]'); if (el && this.mounted) load(el); },
  };

  async function load(el) {
    const r = await Api.get("/api/history");
    const list = r.history || [];
    const box = el.querySelector("#hi-list");
    if (!list.length) { box.innerHTML = `<div class="empty"><span class="big">🕘</span>暂无历史记录</div>`; return; }
    box.innerHTML = `<table class="table"><thead><tr>
      <th>时间</th><th>图像</th><th>流水线</th><th>节点</th><th>耗时</th><th>状态</th><th>兼容性</th><th></th>
    </tr></thead><tbody>` + list.map((e) => `
      <tr data-id="${e.id}" style="cursor:pointer">
        <td class="mono">${C.fmtDate(e.created_at)}</td>
        <td title="${C.esc(e.image_name)}">${C.esc((e.image_name || "").slice(0, 18))}</td>
        <td>${C.esc(e.pipeline_name || "临时")}</td>
        <td>${e.node_count}</td>
        <td>${C.fmtMs(e.duration_ms)}</td>
        <td><span class="badge ${e.status === "ok" ? "green" : "red"}">${e.status === "ok" ? "成功" : "失败"}</span>${e.cache_hit ? ' <span class="badge">缓存</span>' : ""}</td>
        <td>${compatBadge(e.compatibility)}</td>
        <td><button class="btn btn-sm" data-id="${e.id}">查看</button></td>
      </tr>`).join("") + `</tbody></table>`;

    box.querySelectorAll("tr[data-id]").forEach((tr) => {
      tr.onclick = () => {
        current = list.find((x) => x.id === tr.dataset.id);
        box.querySelectorAll("tr").forEach((x) => x.style.background = "");
        tr.style.background = "var(--bg-hover)";
        renderDetail(el, current);
      };
    });
    if (current) renderDetail(el, current);
  }

  /* 快照与当前规则的兼容性徽标：恢复前就能看出能不能跑。 */
  function compatBadge(c) {
    if (!c) return `<span class="badge">未校验</span>`;
    if (c.error_count > 0) {
      return `<span class="badge red" title="${C.esc((c.errors || []).join("\n"))}">不兼容 · ${c.error_count} 错误</span>`;
    }
    if (c.warning_count > 0) {
      return `<span class="badge amber" title="${C.esc((c.warnings || []).join("\n"))}">可运行 · ${c.warning_count} 警告</span>`;
    }
    return `<span class="badge green">兼容</span>`;
  }

  /* 兼容性逐条问题（按节点/连线分组）。 */
  function compatIssuesHTML(c, nodes) {
    if (!c || !(c.issues || []).length) return "";
    const labelOf = (t) => (C._nodesInfo && C._nodesInfo[t] && C._nodesInfo[t].label) || t;
    const nodeById = {};
    (nodes || []).forEach((n) => { nodeById[n.id] = n; });
    const lines = (c.issues || []).map((it) => {
      let where;
      if (it.scope === "edge" && it.edge) {
        const srcNode = nodeById[it.edge[0]];
        const dstNode = nodeById[it.edge[1]];
        const src = srcNode ? labelOf(srcNode.type) : (String(it.edge[0] || "?") + "（已缺失）");
        const dst = dstNode ? labelOf(dstNode.type) : (String(it.edge[1] || "?") + "（已缺失）");
        const fromId = String(it.edge[0] || "?");
        const toId = String(it.edge[1] || "?");
        where = "连线 " + C.esc(src) + "(" + C.esc(fromId) + ") → " +
                C.esc(dst) + "(" + C.esc(toId) + ")";
      } else if (it.scope === "node" && it.node_id) {
        const n = nodeById[it.node_id];
        where = "节点 " + C.esc(n ? labelOf(n.type) : "?") + "(" + C.esc(it.node_id) + ")";
      } else {
        where = "整条流水线";
      }
      return `<li class="${it.severity === "error" ? "invalid-text" : "warn-text"}">${where}：${C.esc(it.message)}</li>`;
    });
    return `<div><span class="dim">当前规则校验</span> ${compatBadge(c)}
      <div class="dim" style="margin-top:2px">按现有节点类型与连线规则实时判定 · 错误 ${c.error_count} / 警告 ${c.warning_count}</div></div>
      <ul class="compat-issues">${lines.join("")}</ul>`;
  }

  function renderDetail(el, e) {
    const box = el.querySelector("#hi-detail");
    const nodes = (e.pipeline_snapshot && e.pipeline_snapshot.nodes) || [];
    const nodeResults = e.node_results || [];
    const c = e.compatibility;
    box.innerHTML = `
      <div class="keypoint-stats" style="line-height:1.9">
        <div><span class="dim">状态</span> <span class="badge ${e.status === "ok" ? "green" : "red"}">${e.status === "ok" ? "成功" : "失败"}</span></div>
        <div><span class="dim">图像</span> ${C.esc(e.image_name || "-")}</div>
        <div><span class="dim">流水线</span> ${C.esc(e.pipeline_name || "临时")}（${e.node_count} 节点）</div>
        <div><span class="dim">耗时</span> ${C.fmtMs(e.duration_ms)} · <span class="dim">缓存</span> ${e.cache_hit ? "命中" : "计算"}</div>
        ${e.error ? `<div><span class="dim">错误</span> ${C.esc(e.error)}</div>` : ""}
        <div><span class="dim">版本快照</span> ${nodes.map((n) => {
          const known = !C._nodesInfo || C._nodesInfo[n.type];
          return `<span class="badge ${known ? "" : "red"}" ${known ? "" : 'title="当前规则中已不存在"'}>${C.esc(n.type)}</span>`;
        }).join(" ") || "无节点"}</div>
        ${nodeResults.length ? `<div><span class="dim">节点执行</span> ${nodeResults.map((n) => `${n.ok ? "✓" : "✗"}${n.node_id}`).join(" ")}</div>` : ""}
      </div>
      <div class="compat-box">${compatIssuesHTML(c, nodes)}</div>
      ${e.result_id ? `<img src="/api/results/${e.result_id}/file" style="width:100%;border-radius:8px;margin-top:10px">` : ""}
      <div class="toolbar" style="margin-top:12px">
        <button class="btn ${c && c.error_count ? "btn-danger" : "btn-primary"}" id="hi-restore">
          ${c && c.error_count ? "仍要恢复为流水线（含 " + c.error_count + " 个错误）" : "恢复为流水线"}
        </button>
        <button class="btn btn-danger" id="hi-del">删除记录</button>
      </div>`;
    box.querySelector("#hi-restore").onclick = async () => {
      if (c && c.error_count && !confirm("该快照与当前规则不兼容，恢复出的流水线无法直接运行：\n\n" +
          c.errors.slice(0, 5).map((m) => "• " + m).join("\n") +
          (c.errors.length > 5 ? `\n…等 ${c.errors.length} 个问题` : "") +
          "\n\n仍要恢复吗？恢复后会在编辑器里标出所有问题节点与连线。")) return;
      const p = await Api.post(`/api/history/${e.id}/restore`);
      await C.refreshPipelines();
      if (p.valid && !(p.warnings || []).length) {
        C.toast("已恢复为流水线：" + p.name + "（校验通过）", "success");
      } else if (p.valid) {
        C.toast("已恢复：" + p.name + "，可运行但有 " + (p.warnings || []).length + " 个警告", "");
      } else {
        C.toast("已恢复，但流水线有 " + (p.errors || []).length + " 个错误，无法直接运行", "error");
      }
      // 直接跳进编辑器并加载，坏节点/坏连线当场可见
      if (window.Views.pipeline && window.Views.pipeline.openPipeline) {
        window.Views.pipeline.openPipeline(p.id);
      }
    };
    box.querySelector("#hi-del").onclick = async () => {
      if (!confirm("删除该历史记录（连同结果文件）？")) return;
      await Api.del(`/api/history/${e.id}`);
      current = null;
      C.toast("已删除", "success");
      load(document.querySelector('.view[data-view="history"]'));
    };
  }
})();
