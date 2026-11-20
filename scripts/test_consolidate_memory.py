#!/usr/bin/env python3
"""Test suite for consolidate_memory.py"""

import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from consolidate_memory import (
    compute_mutation_digest,
    replay_journal,
    find_clusters,
    build_proposal,
    apply_consolidation,
)


class TestConsolidateMemory(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="test_consolidate_")
        self.journal_path = os.path.join(self.test_dir, "journal.jsonl")

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_compute_mutation_digest(self):
        digest = compute_mutation_digest(
            1, "supersede", "op_1", "2026-11-15T00:00:00Z", ["old_1"], {"id": "op_1"}
        )
        self.assertEqual(digest, "7b443d77ab7a1d2a47ae8e43f4049947642fda59f651e0c5a839862baead92fc")

    def test_cluster_and_propose(self):
        # 写入 3 条相同 tag 的 active 记录
        entries = [
            {
                "action": "create",
                "entry": {
                    "id": "fact_001",
                    "kind": "fact",
                    "status": "active",
                    "tags": ["bili_quota"],
                    "content": "B站每天额度为20次",
                },
            },
            {
                "action": "create",
                "entry": {
                    "id": "fact_002",
                    "kind": "fact",
                    "status": "active",
                    "tags": ["bili_quota"],
                    "content": "B站额度超过后降级为只读",
                },
            },
            {
                "action": "create",
                "entry": {
                    "id": "fact_003",
                    "kind": "fact",
                    "status": "active",
                    "tags": ["other_tag"],
                    "content": "小满喜欢吃草莓",
                },
            },
        ]
        with open(self.journal_path, "w", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")

        replayed, _ = replay_journal(self.journal_path)
        self.assertEqual(len(replayed), 3)

        active_entries, clusters = find_clusters(replayed)
        self.assertIn("tag:bili_quota", clusters)
        self.assertEqual(len(clusters["tag:bili_quota"]), 2)

        prop = build_proposal("tag:bili_quota", clusters["tag:bili_quota"])
        self.assertEqual(prop["replaces"], ["fact_001", "fact_002"])
        self.assertEqual(prop["derivedFromIds"], ["fact_001", "fact_002"])
        self.assertEqual(prop["targetEntry"]["supersedesIds"], ["fact_001", "fact_002"])

    def test_apply_consolidation(self):
        # 初始化账本
        init_entries = [
            {
                "action": "create",
                "entry": {
                    "id": "item_a",
                    "kind": "fact",
                    "status": "active",
                    "content": "记录A",
                    "updatedAt": "2026-11-15T10:00:00Z",
                },
            },
            {
                "action": "create",
                "entry": {
                    "id": "item_b",
                    "kind": "fact",
                    "status": "active",
                    "content": "记录B",
                    "updatedAt": "2026-11-15T10:00:00Z",
                },
            },
        ]
        with open(self.journal_path, "w", encoding="utf-8") as f:
            for e in init_entries:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")

        # 提交合并
        target = {
            "id": "item_consolidated_001",
            "kind": "fact",
            "status": "active",
            "content": "合并后的认知AB",
            "supersedesId": "item_a",
            "supersedesIds": ["item_a", "item_b"],
            "createdAt": "2026-11-15T12:00:00Z",
            "updatedAt": "2026-11-15T12:00:00Z",
        }
        replaces = ["item_a", "item_b"]

        apply_consolidation(self.journal_path, target, replaces)

        # 重新回放验证
        final_entries, history = replay_journal(self.journal_path)
        self.assertEqual(final_entries["item_a"]["status"], "superseded")
        self.assertEqual(final_entries["item_a"]["supersededBy"], "item_consolidated_001")
        self.assertEqual(final_entries["item_b"]["status"], "superseded")
        self.assertEqual(final_entries["item_b"]["supersededBy"], "item_consolidated_001")
        self.assertEqual(final_entries["item_consolidated_001"]["status"], "active")

        # 验证产生了备份文件
        bak_files = list(Path(self.test_dir).glob("journal.jsonl.bak.*"))
        self.assertEqual(len(bak_files), 1)

    def test_node_memory_service_interoperability(self):
        # 初始化带完整字段的账本
        init_entries = [
            {
                "action": "create",
                "entry": {
                    "id": "fact_x1",
                    "kind": "fact",
                    "scope": "xiaoman_private",
                    "status": "active",
                    "content": "排错记录1",
                    "confidence": 1.0,
                    "createdAt": "2026-11-15T00:00:00Z",
                    "updatedAt": "2026-11-15T00:00:00Z",
                },
            },
            {
                "action": "create",
                "entry": {
                    "id": "fact_x2",
                    "kind": "fact",
                    "scope": "xiaoman_private",
                    "status": "active",
                    "content": "排错记录2",
                    "confidence": 1.0,
                    "createdAt": "2026-11-15T00:00:00Z",
                    "updatedAt": "2026-11-15T00:00:00Z",
                },
            },
        ]
        with open(self.journal_path, "w", encoding="utf-8") as f:
            for e in init_entries:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")

        target = {
            "id": "fact_consolidated_x",
            "kind": "fact",
            "scope": "xiaoman_private",
            "status": "active",
            "content": "终态事实认知X",
            "confidence": 1.0,
            "confirmed": True,
            "supersedesId": "fact_x1",
            "supersedesIds": ["fact_x1", "fact_x2"],
            "createdAt": "2026-11-15T01:00:00Z",
            "updatedAt": "2026-11-15T01:00:00Z",
        }
        apply_consolidation(self.journal_path, target, ["fact_x1", "fact_x2"])

        # 使用 Node.js MemoryService 真实校验
        import subprocess
        normalized_dir = self.test_dir.replace('\\', '/')
        code = f"""
        import {{ MemoryService }} from './projects/lucidheart/packages/memory/lib/service.js';
        const s = new MemoryService({{ dataDir: '{normalized_dir}' }});
        const active = s.indexer.getAllActive().map(m => m.id);
        if (!active.includes('fact_consolidated_x') || active.includes('fact_x1')) {{
            process.exit(1);
        }}
        const old = s.inspect('fact_x1');
        if (old.status !== 'superseded' || old.supersededBy !== 'fact_consolidated_x') {{
            process.exit(2);
        }}
        s.close();
        """
        res = subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, f"Node MemoryService 校验失败: {res.stderr}")


if __name__ == "__main__":
    unittest.main()
