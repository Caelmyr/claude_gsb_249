/* 视图 2：滤镜链编辑器（拖拽节点、连线、参数调节、运行、保存/加载）。 */
window.Views = window.Views || {};
window.Views.pipeline = (function () {
  const C = window.Common;
  const NODE_W = 176;
  const HEADER_H = 38;

  let nodes = [];          // {id, type, x, y, params, inputs:[]}
  let sel = null;          // 选中节点 id
  let idCounter = 1;
  let nodeEls = {};        // id -> DOM element
  let connecting = null;   // {from, x, y}
  let report = null;       // 当前规则实时校验报告（来自 /api/pipelines/validate）
  let autoLoadId = null;   // 挂载后待自动加载的已保存流水线 id

  // 参考元素
  let canvas, svg, paletteEl, inspectorEl, validationBar, imageSel, runBtn, previewBox;

  function newId() { return "n" + (idCounter++); }

  // ------------------------------------------------------------------ 渲染
  function nodeLabel(type) {
    const nodesInfo = C._nodesInfo || {};
    return (nodesInfo[type] && nodesInfo[type].label) || type;
  }

  function renderPalette(nodeDefs) {
    const byCat = {};
    (nodeDefs || []).forEach((n) => { (byCat[n.category] = byCat[n.category] || []).push(n); });
    const cats = Object.keys(byCat);
    paletteEl.innerHTML = cats.map((cat) => `
      <div class="palette-cat">${C.esc(cat)}</div>
      ${byCat[cat].map((n) => `
        <div class="palette-node" draggable="true" data-type="${n.type}">
          ${C.esc(n.label)}
          <div class="pn-desc">${C.esc(n.desc || "")}</div>
        </div>`).join("")}
    `).join("");
    paletteEl.querySelectorAll(".palette-node").forEach((pn) => {
      pn.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", pn.dataset.type);
        e.dataTransfer.effectAllowed = "copy";
      });
    });
  }

  function nodeState(id) {
    return (report && report.node_status && report.node_status[id]) ? report.node_status[id].state : "ok";
  }

  function nodeTip(id) {
    const st = report && report.node_status && report.node_status[id];
    if (!st) return "";
    return [].concat(st.errors || [], st.warnings || []).map((m) => "• " + m).join("\n");
  }

  function renderNodes() {
    canvas.querySelectorAll(".node").forEach((n) => n.remove());
    nodeEls = {};
    nodes.forEach((n) => {
      const state = nodeState(n.id);
      const tip = nodeTip(n.id);
      const def = C._nodesInfo[n.type];
      const el = C.h(`
        <div class="node ${sel === n.id ? "selected" : ""} ${state !== "ok" ? "state-" + state : ""}" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px">
          <div class="node-header"><span class="dot"></span>${C.esc(nodeLabel(n.type))}
            <span style="flex:1"></span>${state === "invalid" ? '<span class="node-state-badge bad" title="校验未通过">!</span>' : state === "warning" ? '<span class="node-state-badge warn" title="有警告">?</span>' : ""}<span class="node-x" title="删除">×</span></div>
          <div class="node-body">${C.esc(def ? (def.desc || "") : "当前规则中已不存在的节点类型")}</div>
          <div class="port in" data-id="${n.id}" data-port="in"></div>
          <div class="port out" data-id="${n.id}" data-port="out"></div>
        </div>`);
      if (tip) el.title = tip;
      canvas.appendChild(el);
      nodeEls[n.id] = el;
      bindNode(el, n);
    });
    redrawEdges();
  }

  function badEdges() {
    const set = new Set();
    (report && report.issues || []).forEach((it) => {
      if (it.scope === "edge" && it.edge && it.edge.length === 2 && it.severity === "error") {
        set.add(it.edge[0] + "->" + it.edge[1]);
      }
    });
    return set;
  }

  function redrawEdges() {
    const bad = badEdges();
    const paths = [];
    nodes.forEach((n) => {
      (n.inputs || []).forEach((srcId) => {
        const isBad = bad.has(srcId + "->" + n.id);
        const a = nodeEls[srcId], b = nodeEls[n.id];
        if (!a || !b) {
          // 连线另一端节点不存在（悬空边）：画不出线，但也要提示
          if (isBad && b) drawDanglingEdge(b);
          return;
        }
        const x1 = a.offsetLeft + NODE_W, y1 = a.offsetTop + HEADER_H / 2;
        const x2 = b.offsetLeft, y2 = b.offsetTop + HEADER_H / 2;
        const dx = Math.max(28, Math.abs(x2 - x1) / 2);
        paths.push(`<path class="${isBad ? "edge-bad" : ""}" data-edge="${srcId}-&gt;${n.id}" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"/>`);
      });
    });
    svg.innerHTML = paths.join("");
    // 连接中的临时线
    if (connecting) {
      const fromEl = nodeEls[connecting.from];
      const x1 = fromEl.offsetLeft + NODE_W, y1 = fromEl.offsetTop + HEADER_H / 2;
      const dx = Math.max(28, Math.abs(connecting.x - x1) / 2);
      svg.innerHTML += `<path d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${connecting.x - dx} ${connecting.y}, ${connecting.x} ${connecting.y}" style="stroke-dasharray:4 3"/>`;
    }
  }

  function drawDanglingEdge(targetEl) {
    // 起点未知：在目标输入端口外侧画一段红色断连标记
    const x2 = targetEl.offsetLeft, y2 = targetEl.offsetTop + HEADER_H / 2;
    svg.insertAdjacentHTML("beforeend",
      `<circle cx="${x2 - 10}" cy="${y2}" r="5" class="edge-bad-dot"/>`);
  }

  // ------------------------------------------------------------------ 交互
  function bindNode(el, n) {
    // 拖拽节点
    el.querySelector(".node-header").addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("node-x")) return;
      select(n.id);
      const startX = e.clientX, startY = e.clientY;
      const origX = n.x, origY = n.y;
      function move(ev) {
        n.x = origX + (ev.clientX - startX);
        n.y = origY + (ev.clientY - startY);
        n.x = Math.max(0, n.x); n.y = Math.max(0, n.y);
        el.style.left = n.x + "px"; el.style.top = n.y + "px";
        redrawEdges();
      }
      function up() { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });

    el.querySelector(".node-x").addEventListener("click", () => deleteNode(n.id));

    // 端口连线
    el.querySelector(".port.out").addEventListener("mousedown", (e) => {
      e.stopPropagation();
      connecting = { from: n.id, x: e.clientX, y: e.clientY };
      const move = (ev) => {
        const rect = canvas.getBoundingClientRect();
        connecting.x = ev.clientX - rect.left; connecting.y = ev.clientY - rect.top;
        redrawEdges();
      };
      const up = () => { connecting = null; redrawEdges(); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    el.querySelector(".port.in").addEventListener("mouseup", (e) => {
      e.stopPropagation();
      if (connecting && connecting.from !== n.id) {
        n.inputs = [connecting.from];
        connecting = null;
        renderNodes();
        select(n.id);
        scheduleValidate();
      }
    });
  }

  function select(id) {
    sel = id;
    Object.values(nodeEls).forEach((el) => el.classList.toggle("selected", el.dataset.id === id));
    renderInspector();
  }

  function deleteNode(id) {
    nodes = nodes.filter((n) => n.id !== id);
    nodes.forEach((n) => { n.inputs = (n.inputs || []).filter((s) => s !== id); });
    if (sel === id) sel = null;
    renderNodes();
    renderInspector();
    scheduleValidate();
  }

  function addNode(type, x, y) {
    const def = (C._nodesInfo || {})[type];
    if (!def) return;
    nodes.push({ id: newId(), type, x, y, params: {}, inputs: [] });
    renderNodes();
    const last = nodes[nodes.length - 1];
    select(last.id);
    scheduleValidate();
  }

  // ------------------------------------------------------------------ 实时校验
  let validateTimer = null;

  function scheduleValidate() {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(refreshValidation, 300);
  }

  async function refreshValidation() {
    if (!nodes.length) { report = null; renderValidationBar(); renderNodes(); return; }
    try {
      report = await Api.post("/api/pipelines/validate", { nodes: nodes.map(strip) });
    } catch (e) {
      report = { valid: false, errors: ["校验请求失败：" + e.message], warnings: [], issues: [], node_status: {} };
    }
    renderValidationBar();
    renderNodes();
    // 只刷新选中节点旁的问题徽标/清单，不重建参数表单（避免拖滑块时输入焦点抖动）
    if (sel) {
      const header = inspectorEl.querySelector(".panel-title");
      if (header) {
        const st = nodeState(sel);
        header.querySelectorAll(".badge").forEach((b) => b.remove());
        if (st === "invalid") header.insertAdjacentHTML("beforeend", ' <span class="badge red">校验未通过</span>');
        if (st === "warning") header.insertAdjacentHTML("beforeend", ' <span class="badge amber">有警告</span>');
      }
      renderNodeIssueBox(sel);
    }
  }

  function renderValidationBar() {
    const bar = validationBar;
    if (!bar) return;
    if (!nodes.length || !report) { bar.hidden = true; return; }
    const errs = report.errors || [];
    const warns = report.warnings || [];
    bar.classList.remove("ok", "error", "warning");
    if (!errs.length && !warns.length) {
      bar.classList.add("ok");
      bar.innerHTML = `✓ 通过当前规则校验，可直接运行`;
    } else if (errs.length) {
      bar.classList.add("error");
      bar.innerHTML = `✗ 校验未通过 · ${errs.length} 个错误${warns.length ? " · " + warns.length + " 个警告" : ""}，此流水线<b>无法运行</b><ul>${
        errs.map((m) => `<li>${C.esc(m)}</li>`).join("")}</ul>${warns.length ? `<ul class="vb-warn">${warns.map((m) => `<li>${C.esc(m)}</li>`).join("")}</ul>` : ""}`;
    } else {
      bar.classList.add("warning");
      bar.innerHTML = `? ${warns.length} 个警告（可运行，但参数与当前规则有偏差）<ul class="vb-warn">${
        warns.map((m) => `<li>${C.esc(m)}</li>`).join("")}</ul>`;
    }
    bar.hidden = false;
  }

  // ------------------------------------------------------------------ 检查器
  function renderInspector() {
    const node = nodes.find((n) => n.id === sel);
    let paramHTML = `<div class="empty">未选择节点<br><span style="font-size:12px">从左侧拖入节点，或点击已有节点编辑参数</span></div>`;
    if (node) {
      const def = C._nodesInfo[node.type];
      if (!def) {
        paramHTML = `
          <div class="panel-title"><span class="invalid-text">未知节点类型</span> <span class="dim">#${C.esc(node.id)}</span></div>
          <div class="invalid-box">类型 <code>${C.esc(node.type)}</code> 在当前节点规则中已不存在（可能来自旧版本快照）。<br>请删除该节点并替换为现有类型，否则流水线无法运行。</div>
          <div class="toolbar" style="margin-top:10px">
            <button class="btn btn-sm btn-danger" id="insp-del">删除节点</button>
            <button class="btn btn-sm" id="insp-clear">清空全部</button>
          </div>`;
        setTimeout(() => {
          inspectorEl.querySelector("#insp-del").onclick = () => deleteNode(node.id);
          inspectorEl.querySelector("#insp-clear").onclick = () => { nodes = []; sel = null; renderNodes(); renderInspector(); scheduleValidate(); };
        }, 0);
      } else {
        const form = C.schemaForm(def.schema, node.params);
        paramHTML = `
          <div class="panel-title">${C.esc(nodeLabel(node.type))} <span class="dim">#${node.id}</span>${nodeState(node.id) === "invalid" ? ' <span class="badge red">校验未通过</span>' : nodeState(node.id) === "warning" ? ' <span class="badge amber">有警告</span>' : ""}</div>
          <div id="insp-node-issues"></div>
          <div class="param-grid">${form.html}</div>
          <div class="toolbar" style="margin-top:10px">
            <button class="btn btn-sm btn-danger" id="insp-del">删除节点</button>
            <button class="btn btn-sm" id="insp-clear">清空全部</button>
          </div>`;
        // 延迟绑定表单
        setTimeout(() => {
          const box = inspectorEl.querySelector(".param-grid");
          if (box) {
            form.bind(box, (vals) => { node.params = vals; scheduleValidate(); });
          }
          renderNodeIssueBox(node.id);
          inspectorEl.querySelector("#insp-del").onclick = () => deleteNode(node.id);
          inspectorEl.querySelector("#insp-clear").onclick = () => { nodes = []; sel = null; renderNodes(); renderInspector(); scheduleValidate(); };
        }, 0);
      }
    }
    inspectorEl.querySelector("#insp-node").innerHTML = paramHTML;
    renderRunSection();
  }

  function renderNodeIssueBox(id) {
    const st = report && report.node_status && report.node_status[id];
    const box = inspectorEl.querySelector("#insp-node-issues");
    if (!box || !st) return;
    const rows = []
      .concat((st.errors || []).map((m) => `<li class="invalid-text">${C.esc(m)}</li>`))
      .concat((st.warnings || []).map((m) => `<li class="warn-text">${C.esc(m)}</li>`));
    box.innerHTML = rows.length ? `<ul class="node-issue-list">${rows.join("")}</ul>` : "";
  }

  function renderRunSection() {
    // 图像选择 + 运行 + 预览（保持在检查器底部，不随节点选择重建而丢失图片选择）
    if (!inspectorEl.querySelector("#insp-run")) {
      inspectorEl.insertAdjacentHTML("beforeend", `
        <div class="panel-title" style="margin-top:16px">运行预览</div>
        <div class="field"><label>选择输入图像</label><select id="insp-image"></select></div>
        <div class="toolbar">
          <button class="btn btn-primary" id="insp-run">▶ 运行流水线</button>
          <button class="btn" id="insp-save">保存</button>
        </div>
        <div class="field"><label>加载已保存流水线</label>
          <div class="select-row"><select id="insp-load"></select><button class="btn btn-sm" id="insp-load-btn">加载</button></div>
        </div>
        <div id="insp-preview" class="stage" style="margin-top:10px;min-height:120px"><span class="dim">运行后在此显示结果</span></div>`);
      inspectorEl.querySelector("#insp-run").onclick = runPipeline;
      inspectorEl.querySelector("#insp-save").onclick = savePipeline;
      inspectorEl.querySelector("#insp-load-btn").onclick = loadPipeline;
      loadImageOptions();
      loadPipelineOptions();
    }
  }

  async function loadImageOptions() {
    const sel = inspectorEl.querySelector("#insp-image");
    const images = await C.fetchImages();
    sel.innerHTML = `<option value="">— 选择图像 —</option>` +
      images.map((i) => `<option value="${i.id}">${C.esc(i.filename)} (${i.width}×${i.height})</option>`).join("");
  }

  async function loadPipelineOptions() {
    const sel = inspectorEl.querySelector("#insp-load");
    const ps = await C.fetchPipelines();
    sel.innerHTML = `<option value="">— 选择流水线 —</option>` +
      ps.map((p) => {
        const tag = p.valid === false ? "（不兼容，不可运行）"
          : (p.warning_count ? "（" + p.warning_count + " 警告）" : "");
        return `<option value="${p.id}">${C.esc(p.name)}${tag}</option>`;
      }).join("");
  }

  async function runPipeline() {
    const imageId = inspectorEl.querySelector("#insp-image").value;
    if (!imageId) { C.toast("请先选择输入图像", "error"); return; }
    if (!nodes.length) { C.toast("流水线为空，请先添加节点", "error"); return; }
    if (report && !report.valid) {
      const msg = (report.errors || []).slice(0, 3).join("\n");
      if (!confirm("流水线未通过当前规则校验，运行必然失败：\n\n" + msg +
        (report.errors.length > 3 ? `\n…等 ${report.errors.length} 个错误` : "") +
        "\n\n仍要尝试运行吗？")) return;
    } else if (report && (report.warnings || []).length) {
      if (!confirm("流水线存在 " + report.warnings.length + " 个警告，可运行但结果可能与预期不符。仍要运行吗？")) return;
    }
    const preview = inspectorEl.querySelector("#insp-preview");
    preview.innerHTML = `<div class="loading">运行中…</div>`;
    try {
      const r = await Api.post("/api/run", { image_id: imageId, nodes: nodes.map(strip), pipeline_name: "临时流水线" });
      if (r.validation && !r.validation.valid) {
        preview.innerHTML = `<div class="empty">流水线未通过校验，已取消运行。<br><span class="dim">请按上方红色提示修复节点/连线后再试。</span></div>`;
        C.toast("校验未通过，未执行运行", "error");
        report = r.validation;
        renderValidationBar();
        renderNodes();
        renderInspector();
        return;
      }
      preview.innerHTML = `
        <img src="${r.file_url}?t=${Date.now()}">
        <div class="caption">${r.cache_hit ? "缓存命中" : "已计算"} · ${(r.meta && r.meta.count != null) ? "对象 " + r.meta.count : ""}</div>`;
      // 标记失败节点
      const failed = (r.node_results || []).filter((n) => !n.ok);
      if (failed.length) {
        C.toast("有节点执行失败：" + failed.map((f) => f.node_id).join(", "), "error");
        Object.values(nodeEls).forEach((el) => el.classList.remove("error"));
        failed.forEach((f) => { if (nodeEls[f.node_id]) nodeEls[f.node_id].classList.add("error"); });
      }
    } catch (e) {
      preview.innerHTML = `<div class="empty">运行失败：${C.esc(e.message)}</div>`;
    }
  }

  function strip(n) { return { id: n.id, type: n.type, params: n.params, inputs: n.inputs, x: n.x, y: n.y }; }

  function savePipeline() {
    const m = C.modal(`<div class="field"><label>流水线名称</label><input type="text" id="sp-name" value="我的流水线"></div>
      <div class="modal-actions"><button class="btn" id="sp-cancel">取消</button><button class="btn btn-primary" id="sp-ok">保存</button></div>`, "保存流水线");
    m.el.querySelector("#sp-cancel").onclick = m.close;
    m.el.querySelector("#sp-ok").onclick = async () => {
      const name = m.el.querySelector("#sp-name").value || "未命名流水线";
      const saved = await Api.post("/api/pipelines", { name, nodes: nodes.map(strip) });
      m.close();
      if (saved.valid === false) {
        C.toast("已保存，但存在 " + (saved.errors || []).length + " 个校验错误，该流水线当前无法运行", "error");
      } else if ((saved.warnings || []).length) {
        C.toast("已保存，有 " + saved.warnings.length + " 个警告（可运行）", "");
      } else {
        C.toast("已保存流水线（校验通过）", "success");
      }
      await C.refreshPipelines();
      loadPipelineOptions();
    };
  }

  async function loadPipelineById(pid) {
    if (!pid) return false;
    const ps = await C.refreshPipelines();
    const p = ps.find((x) => x.id === pid);
    if (!p) return false;
    loadPipelineData(p);
    return true;
  }

  function loadPipelineData(p) {
    // 新 id 要避开快照里所有已有/悬空引用（悬空引用可能形如 n9，节点本身已缺失），
    // 否则重新校验时悬空边可能错误地指向新节点。
    let maxNum = 0;
    const usedIds = new Set();
    (p.nodes || []).forEach((n) => {
      usedIds.add(n.id);
      const m = /^n(\d+)$/.exec(n.id || "");
      if (m) maxNum = Math.max(maxNum, Number(m[1]));
      (n.inputs || []).forEach((s) => {
        usedIds.add(s);
        const mm = /^n(\d+)$/.exec(s || "");
        if (mm) maxNum = Math.max(maxNum, Number(mm[1]));
      });
    });
    idCounter = maxNum + 1;
    nodes = (p.nodes || []).map((n, i) => ({
      id: newId(), type: n.type, params: n.params, inputs: n.inputs,
      x: n.x != null ? n.x : 20 + (i % 4) * 220, y: n.y != null ? n.y : 20 + Math.floor(i / 4) * 130,
    }));
    // 用映射表重写 inputs 引用；悬空引用（源节点不存在）原样保留为唯一的占位 id，
    // 让实时校验继续把这条坏连线标红，而不是悄悄抹掉问题。
    const map = {};
    p.nodes.forEach((n, i) => { map[n.id] = nodes[i].id; });
    const dangling = new Set();
    nodes.forEach((n) => {
      n.inputs = (n.inputs || []).map((s) => {
        if (map[s]) return map[s];
        // 悬空：保留一个不与任何真实节点重合的 id
        let dId = s;
        while (!dId || usedIds.has(dId) || nodes.some((x) => x.id === dId)) {
          dId = "missing_" + newId();
        }
        usedIds.add(dId);
        dangling.add(dId);
        return dId;
      });
    });
    sel = null;
    renderNodes();
    renderInspector();
    refreshValidation();
  }

  async function loadPipeline() {
    const pid = inspectorEl.querySelector("#insp-load").value;
    if (!pid) return;
    const ok = await loadPipelineById(pid);
    C.toast(ok ? "已加载流水线" : "加载失败，流水线可能已被删除", ok ? "success" : "error");
  }

  // ------------------------------------------------------------------ 挂载
  return {
    mount(el) {
      el.innerHTML = `
        <div class="pipeline-layout">
          <div class="node-palette" id="pl-palette">
            <div class="panel-title">节点面板<span class="dim">拖入画布</span></div>
          </div>
          <div class="canvas-wrap" id="pl-canvas-wrap">
            <div class="canvas-hint">从左侧拖入节点 · 拖「输出」端口到另一节点的「输入」端口连线 · 拖节点头部移动</div>
            <div id="pl-validation" class="validation-bar" hidden></div>
            <div class="canvas" id="pl-canvas"></div>
          </div>
          <div class="pipeline-inspector" id="pl-inspector">
            <div id="insp-node"></div>
          </div>
        </div>`;

      paletteEl = el.querySelector("#pl-palette");
      canvas = el.querySelector("#pl-canvas");
      validationBar = el.querySelector("#pl-validation");
      const wrap = el.querySelector("#pl-canvas-wrap");
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      canvas.appendChild(svg);
      inspectorEl = el.querySelector("#pl-inspector");

      // 画布 drop
      wrap.addEventListener("dragover", (e) => e.preventDefault());
      wrap.addEventListener("drop", (e) => {
        e.preventDefault();
        const type = e.dataTransfer.getData("text/plain");
        const rect = canvas.getBoundingClientRect();
        addNode(type, e.clientX - rect.left - NODE_W / 2, e.clientY - rect.top - HEADER_H / 2);
      });

      C.fetchNodes().then((defs) => {
        C._nodesInfo = C._nodesInfo || {};
        defs.forEach((d) => { C._nodesInfo[d.type] = d; });
        renderPalette(defs);
        // 节点定义到位后重绘一次（从历史恢复跳转过来时，类型中文名/已删除类型提示才准确）
        if (nodes.length) { renderNodes(); renderInspector(); }
      });

      renderNodes();
      renderInspector();
      loadImageOptions();
      loadPipelineOptions();
      // 首次挂载也可能带着历史恢复的自动加载请求
      if (autoLoadId) {
        const pid = autoLoadId;
        autoLoadId = null;
        loadPipelineById(pid);
      }
    },
    refresh() {
      loadImageOptions();
      loadPipelineOptions();
      // 历史页「恢复」后要求直接打开刚生成的流水线并定位问题
      if (autoLoadId) {
        const pid = autoLoadId;
        autoLoadId = null;
        loadPipelineById(pid);
      }
    },
    /* 切到本视图并加载指定流水线（供历史恢复后跳转）。 */
    openPipeline(pid) {
      autoLoadId = pid;
      window.App.show("pipeline");
    },
  };
})();
