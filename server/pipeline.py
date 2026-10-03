"""流水线引擎：DAG 校验、拓扑排序、执行与结果组装。

难点之一「流水线引擎设计」的核心实现：

- 节点用 inputs 表达依赖边（单输入链式，支持扇出）。执行前做完整校验：
  类型存在性、id 唯一、输入引用存在、输入数量在 min/max 内、无环，以及参数与
  当前 schema 的一致性。validate_details() 返回带节点/连线定位的结构化诊断
  （error 不可运行 / warning 可运行但有偏差），供历史恢复与编辑器在运行前标记问题。
- Kahn 拓扑排序决定执行顺序；每个节点消费其唯一上游节点的输出「数据包」，
  数据包 = 图像 + meta（meta 携带关键点/检测框/分割区域等非图像数据，
  供检测->画框、分割->统计这类下游节点复用）。
- 每节点执行包裹 try/except，错误记录到该节点，前端可定位失败点。
- canonical_key() 生成与拓扑顺序无关的确定性哈希，供结果缓存使用。
"""
import json

from . import nodes as node_registry


class Packet:
    """节点间传递的数据包：图像 + 附加元数据。"""

    def __init__(self, image=None, meta=None):
        self.image = image
        self.meta = meta if meta is not None else {}


def _merge_params(node):
    spec = node_registry.get_node(node.get("type"))
    defaults = dict(spec["defaults"]) if spec else {}
    merged = dict(defaults)
    merged.update(node.get("params") or {})
    return merged


def validate(nodes):
    """返回错误信息列表；空列表表示可运行（警告不影响）。"""
    return validate_details(nodes)["errors"]


def validate_details(nodes):
    """按当前节点注册表与连线规则完整校验一份流水线节点列表。

    旧快照（历史恢复等）可能含已删除的节点类型、已失效的连线或与当前 schema
    不符的参数，必须在运行前暴露出来。返回结构化诊断报告：

      errors   - 错误信息列表（存在即代表无法运行）
      warnings - 警告信息列表（能跑，但参数与当前规则有偏差）
      issues   - 逐条诊断：{severity: error|warning, scope: pipeline|node|edge,
                           node_id, edge: [from, to], message}
      valid    - 是否可运行（无 error）
      node_status - {node_id: {"state": invalid|warning|ok,
                               "errors": [...], "warnings": [...]}}
    """
    errors, warnings, issues = [], [], []
    node_status = {}

    def _add(severity, message, node_id=None, edge=None):
        issues.append({"severity": severity, "scope": "edge" if edge else
                       ("node" if node_id else "pipeline"),
                       "node_id": node_id, "edge": edge, "message": message})
        (errors if severity == "error" else warnings).append(message)
        if node_id:
            st = node_status.setdefault(node_id, {"state": "ok", "errors": [], "warnings": []})
            (st["errors"] if severity == "error" else st["warnings"]).append(message)
            st["state"] = "invalid" if st["errors"] else "warning"

    if not isinstance(nodes, list):
        _add("error", "流水线节点不是列表，无法解析")
        return _build_report(errors, warnings, issues, node_status)

    ids = set()
    for n in nodes:
        if not isinstance(n, dict):
            _add("error", f"存在非法节点（应为对象，实际为 {type(n).__name__}）")
            continue
        nid = n.get("id")
        if not nid:
            _add("error", "存在缺少 id 的节点")
            continue
        if nid in ids:
            _add("error", f"节点 id 重复：{nid}", node_id=nid)
        ids.add(nid)
        spec = node_registry.get_node(n.get("type"))
        if spec is None:
            _add("error", f"未知节点类型：{n.get('type')}（当前规则中已不存在）", node_id=nid)
            continue
        ni = len(n.get("inputs") or [])
        if ni < spec["min_inputs"] or ni > spec["max_inputs"]:
            _add("error",
                 f"输入数量 {ni} 超出允许范围 [{spec['min_inputs']}, {spec['max_inputs']}]",
                 node_id=nid)
        _check_params(n, spec, _add)

    for n in nodes:
        if not isinstance(n, dict) or not n.get("id"):
            continue
        nid, ntype = n["id"], n.get("type")
        spec = node_registry.get_node(ntype)
        inputs = n.get("inputs") or []
        for inp in inputs:
            if not inp:
                _add("error", "存在空的输入引用", node_id=nid)
            elif inp not in ids:
                _add("error", f"连线指向不存在的节点：{inp}", node_id=nid, edge=[inp, nid])
            elif inp == nid:
                _add("error", "节点连线指向自身，构成自环", node_id=nid, edge=[inp, nid])
        if spec and spec["max_inputs"] <= 1 and len(set(inputs)) != len(inputs):
            _add("error", "同一条输入连线被重复引用", node_id=nid)

    # 环：结构引用无误后再做拓扑判定（悬空边等会让 Kahn 队列无法排空，造成误报）。
    # 参数类问题不影响拓扑，因此只要没有结构性错误，就照常检查环。
    structural_errors = len(errors)
    if not structural_errors and ids:
        _, leftover = _topo(nodes)
        if leftover:
            _add("error", "流水线存在环，无法执行（涉及节点：%s）" % ", ".join(sorted(leftover)))

    return _build_report(errors, warnings, issues, node_status)


def _build_report(errors, warnings, issues, node_status):
    for st in node_status.values():
        if st["errors"]:
            st["state"] = "invalid"
        elif st["warnings"]:
            st["state"] = "warning"
        else:
            st["state"] = "ok"
    return {"errors": errors, "warnings": warnings, "issues": issues,
            "valid": not errors, "node_status": node_status}


def _check_params(node, spec, add):
    """按当前参数 schema 检查旧快照里的参数值。"""
    nid = node.get("id")
    params = node.get("params")
    if params is None:
        return
    if not isinstance(params, dict):
        add("error", "参数不是对象（键值表），无法解析", node_id=nid)
        return
    keys = {p["key"]: p for p in spec["schema"]}
    for key, val in params.items():
        pdef = keys.get(key)
        if pdef is None:
            add("warning", f"参数 {key} 在当前「{spec['label']}」节点中已不存在，将被忽略",
                node_id=nid)
            continue
        ptype = pdef["type"]
        if ptype == "select":
            options = [str(o) for o in pdef["options"]]
            if val is not None and str(val) not in options:
                add("error",
                    f"参数 {pdef['label']} 的取值「{val}」不在当前可选范围 {pdef['options']}",
                    node_id=nid)
        elif ptype == "bool":
            if not isinstance(val, bool):
                add("warning", f"参数 {pdef['label']} 应为布尔值（当前为 {val}），将被转换",
                    node_id=nid)
        elif ptype in ("range", "number"):
            try:
                fv = float(val)
            except (TypeError, ValueError):
                add("error", f"参数 {pdef['label']} 不是数值（当前为 {val!r}）", node_id=nid)
                continue
            lo, hi = pdef.get("min"), pdef.get("max")
            if (lo is not None and fv < lo) or (hi is not None and fv > hi):
                rng = f"[{lo}, {hi}]" if lo is not None and hi is not None else f">= {lo}"
                add("warning",
                    f"参数 {pdef['label']} 的值 {val} 超出当前范围 {rng}，运行时会被裁剪",
                    node_id=nid)
        elif ptype == "color":
            if not isinstance(val, str) or not val.startswith("#"):
                add("warning", f"参数 {pdef['label']} 不是颜色值（当前为 {val!r}）", node_id=nid)


def _topo(nodes):
    """Kahn 拓扑排序。返回 (ordered_ids, remaining_ids)。"""
    indeg = {}
    children = {}
    by_id = {n["id"]: n for n in nodes}
    for n in nodes:
        indeg[n["id"]] = len(n.get("inputs") or [])
        children.setdefault(n["id"], [])
    for n in nodes:
        for inp in (n.get("inputs") or []):
            children.setdefault(inp, []).append(n["id"])

    queue = [nid for nid, d in indeg.items() if d == 0]
    ordered = []
    while queue:
        nid = queue.pop(0)
        ordered.append(nid)
        for c in children.get(nid, []):
            indeg[c] -= 1
            if indeg[c] == 0:
                queue.append(c)
    remaining = [nid for nid, d in indeg.items() if d > 0]
    return ordered, remaining


def topological_order(nodes):
    ordered, _ = _topo(nodes)
    return ordered


def canonical_key(nodes):
    """生成与布局/命名无关的确定性流水线指纹（供缓存命中判定）。"""
    ordered, _ = _topo(nodes)
    by_id = {n["id"]: n for n in nodes}
    seq = []
    for nid in ordered:
        n = by_id[nid]
        seq.append({"type": n["type"], "params": _merge_params(n)})
    return json.dumps(seq, sort_keys=True, separators=(",", ":"))


def execute(image, nodes, source_meta=None):
    """在给定图像上执行流水线。

    返回 dict：
      image          - 最终结果图像（主输出）
      meta           - 主输出的 meta
      node_results   - [{node_id, type, ok, error}] 逐节点状态
      output_node_id - 主输出节点（无节点时为 None）
      error          - 顶层错误（校验失败等）
    """
    errors = validate(nodes)
    if errors:
        return {"image": image, "meta": source_meta or {}, "node_results": [],
                "output_node_id": None, "error": "; ".join(errors)}

    ordered, _ = _topo(nodes)
    by_id = {n["id"]: n for n in nodes}
    packets = {"__source__": Packet(image, source_meta or {})}
    node_results = []

    for nid in ordered:
        node = by_id[nid]
        spec = node_registry.get_node(node["type"])
        inputs = node.get("inputs") or []
        input_packet = packets.get(inputs[0], packets["__source__"]) if inputs else packets["__source__"]
        params = _merge_params(node)
        try:
            out_img, out_meta = spec["handler"](input_packet.image, params, input_packet.meta)
            packets[nid] = Packet(out_img, out_meta)
            node_results.append({"node_id": nid, "type": node["type"], "ok": True, "error": None})
        except Exception as exc:  # noqa: BLE001 —— 记录但继续，让前端能看到失败节点
            packets[nid] = Packet(input_packet.image, input_packet.meta)
            node_results.append({"node_id": nid, "type": node["type"], "ok": False,
                                 "error": f"{type(exc).__name__}: {exc}"})

    # 主输出 = 无下游消费者的节点中拓扑序最后一个；无节点则输出源图
    consumers = set()
    for n in nodes:
        for inp in (n.get("inputs") or []):
            consumers.add(inp)
    sinks = [nid for nid in ordered if nid not in consumers]
    output_node_id = sinks[-1] if sinks else (ordered[-1] if ordered else None)

    if output_node_id:
        out = packets[output_node_id]
    else:
        out = packets["__source__"]

    return {"image": out.image, "meta": out.meta, "node_results": node_results,
            "output_node_id": output_node_id, "error": None}
