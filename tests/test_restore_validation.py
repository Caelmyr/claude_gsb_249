"""恢复历史快照时的校验回归测试。

背景：历史快照是不同时期保存的，节点类型/连线规则可能已变更。
恢复为流水线时必须用「当前」校验规则检查并把问题标出来，
而不是默认 valid=True、等运行时才报错。

运行：python tests/test_restore_validation.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import pipeline as pipeline_engine  # noqa: E402
from server.api import bp, history, pipelines_store  # noqa: E402
from flask import Flask  # noqa: E402

GOOD_NODES = [
    {"id": "n1", "type": "brightness", "params": {"amount": 10}, "inputs": []},
    {"id": "n2", "type": "blur", "params": {"radius": 2}, "inputs": ["n1"]},
]

# 模拟旧版本快照：类型已改名、连线指向已删除节点、成环、id 重复
BROKEN_NODES = [
    {"id": "a", "type": "gaussian_blur", "params": {}, "inputs": []},      # 已不存在的类型
    {"id": "b", "type": "brightness", "params": {}, "inputs": ["ghost"]},  # 悬空连线
    {"id": "a", "type": "contrast", "params": {}, "inputs": []},           # 重复 id
]

CYCLE_NODES = [
    {"id": "x", "type": "brightness", "params": {}, "inputs": ["y"]},
    {"id": "y", "type": "contrast", "params": {}, "inputs": ["x"]},
]

_failures = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {name}" + (f"  -- {detail}" if detail and not cond else ""))
    if not cond:
        _failures.append(name)


def main():
    print("== validate_detailed 结构化校验 ==")
    issues = pipeline_engine.validate_detailed(GOOD_NODES)
    check("合法流水线无问题", issues == [])

    issues = pipeline_engine.validate_detailed(BROKEN_NODES)
    kinds = {i["kind"] for i in issues}
    check("未知类型被标出", "unknown_type" in kinds)
    check("悬空连线被标出", "missing_input" in kinds)
    check("重复 id 被标出", "duplicate_id" in kinds)
    check("问题定位到节点", all("node_id" in i and "message" in i for i in issues))
    mi = next(i for i in issues if i["kind"] == "missing_input")
    check("连线问题带上源 id", mi["input"] == "ghost" and mi["node_id"] == "b")

    issues = pipeline_engine.validate_detailed(CYCLE_NODES)
    check("环被标出且定位到环节点",
          bool(issues) and all(i["kind"] == "cycle" for i in issues)
          and {i["node_id"] for i in issues} == {"x", "y"})

    check("validate() 保持扁平错误列表兼容",
          all(isinstance(m, str) for m in pipeline_engine.validate(BROKEN_NODES)))

    print("\n== HTTP：恢复时即用当前规则校验 ==")
    app = Flask(__name__)
    app.register_blueprint(bp)
    client = app.test_client()

    created_pids, created_hids = [], []
    try:
        # 造两条历史：一条快照是好的，一条是旧版坏快照
        h_good = history.add({"pipeline_name": "好的旧版", "pipeline_snapshot": {"nodes": GOOD_NODES},
                              "node_count": len(GOOD_NODES), "status": "ok"})
        h_bad = history.add({"pipeline_name": "坏的旧版", "pipeline_snapshot": {"nodes": BROKEN_NODES},
                             "node_count": len(BROKEN_NODES), "status": "ok"})
        created_hids += [h_good["id"], h_bad["id"]]

        r = client.post(f"/api/history/{h_bad['id']}/restore")
        body = r.get_json()
        created_pids.append(body["id"])
        check("坏快照恢复后 valid=False", body["valid"] is False)
        check("坏快照恢复返回逐条问题", len(body["validation"]) >= 3)
        check("问题含 kind/node_id 定位",
              all("kind" in i and "node_id" in i for i in body["validation"]))

        r = client.post(f"/api/history/{h_good['id']}/restore")
        body = r.get_json()
        created_pids.append(body["id"])
        check("好快照恢复后 valid=True", body["valid"] is True and body["validation"] == [])

        # 列表/详情接口也必须带有效性（运行前就能看出来）
        r = client.get("/api/pipelines").get_json()["pipelines"]
        restored = {p["id"]: p for p in r if p["id"] in created_pids}
        check("流水线列表携带 valid 标记",
              len(restored) == 2 and restored[created_pids[0]]["valid"] is False
              and restored[created_pids[1]]["valid"] is True)
        check("列表中的问题明细与恢复时一致",
              len(restored[created_pids[0]]["validation"]) >= 3)

        # 预检接口
        r = client.post("/api/pipelines/validate", json={"nodes": BROKEN_NODES}).get_json()
        check("预检接口标出坏节点", r["valid"] is False and len(r["issues"]) >= 3)
        r = client.post("/api/pipelines/validate", json={"nodes": GOOD_NODES}).get_json()
        check("预检接口放行好节点", r["valid"] is True and r["issues"] == [])
    finally:
        for pid in created_pids:
            pipelines_store.update(lambda doc: {k: v for k, v in doc.items() if k != pid})
        for hid in created_hids:
            history.delete(hid)

    print()
    if _failures:
        print(f"共 {len(_failures)} 项失败：{_failures}")
        sys.exit(1)
    print("全部恢复校验测试通过 ✔")


if __name__ == "__main__":
    main()
