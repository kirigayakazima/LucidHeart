#!/usr/bin/env python3
"""Offline Memory Consolidator (带外受控记忆沉淀脚本)

依据 DSHA Dreaming 2.0 规范：
1. 只读聚类扫描：扫描 journal.jsonl 中重复/迭代的排错记忆与碎片事实
2. 提案生成 (Proposal)：生成候选合并条目，保留 derivedFromIds 作为审计证据
3. 原子提交 (Commit)：生成符合 @dsh/memory 规范的单笔 supersede 事务，校验 SHA-256 Checksum，旧条目优雅归档
"""

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

# 禁止产生 __pycache__
sys.dont_write_bytecode = True

MUTATION_VERSION = 1


def normalize_json_types(obj):
    """规范化数值类型，使 Python 的整数型浮点数 (如 1.0) 序列化为 1，与 Node.js JSON.stringify 保持 100% 字节一致"""
    if isinstance(obj, float) and obj.is_integer():
        return int(obj)
    if isinstance(obj, dict):
        return {k: normalize_json_types(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [normalize_json_types(v) for v in obj]
    return obj


def compute_mutation_digest(mutation_version, action, operation_id, timestamp, replaces, entry):
    """计算与 @dsh/memory store.js 100% 逐字节兼容的 sha256 签名"""
    normalized_entry = normalize_json_types(entry)
    payload = json.dumps(
        [mutation_version, action, operation_id, timestamp, replaces, normalized_entry],
        separators=(',', ':'),
        ensure_ascii=False
    ).encode('utf-8')
    return hashlib.sha256(payload).hexdigest()


def replay_journal(journal_path):
    """回放 journal.jsonl，重构当前所有事实条目的最新状态"""
    if not os.path.exists(journal_path):
        return {}, []

    entries = {}
    history = []

    with open(journal_path, 'r', encoding='utf-8') as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception as e:
                print(f"[!] 警告: 行 {line_num} JSON 解析失败: {e}", file=sys.stderr)
                continue

            history.append(rec)
            action = rec.get('action')
            entry = rec.get('entry', {})
            entry_id = entry.get('id')
            if not entry_id:
                continue

            if action in ('create', 'update'):
                entries[entry_id] = entry
            elif action == 'supersede':
                replaces = rec.get('replaces') or entry.get('supersedesIds') or [entry.get('supersedesId')]
                replaces = [r for r in replaces if r]
                now_str = rec.get('timestamp', entry.get('updatedAt', ''))
                for r_id in replaces:
                    if r_id in entries:
                        entries[r_id] = {
                            **entries[r_id],
                            'status': 'superseded',
                            'supersededBy': entry_id,
                            'updatedAt': now_str,
                            'validTo': now_str,
                        }
                entries[entry_id] = entry
            elif action == 'revoke':
                if entry_id in entries:
                    entries[entry_id] = {
                        **entries[entry_id],
                        'status': 'revoked',
                        'updatedAt': rec.get('timestamp', ''),
                    }

    return entries, history


def find_clusters(entries):
    """根据 tags 和 entities 将处于 active 状态的条目进行候选聚类"""
    active_entries = {k: v for k, v in entries.items() if v.get('status') == 'active'}
    
    tag_clusters = defaultdict(list)
    for eid, entry in active_entries.items():
        tags = entry.get('tags') or []
        for tag in tags:
            tag_clusters[f"tag:{tag}"].append(entry)

    # 过滤出存在 2 条以上 active 记录的候选群组
    candidate_clusters = {}
    for cluster_name, items in tag_clusters.items():
        if len(items) >= 2:
            candidate_clusters[cluster_name] = items

    return active_entries, candidate_clusters


def build_proposal(cluster_name, items):
    """为冗余群组构建合并 Proposal 方案"""
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    replaces = [item['id'] for item in items]
    cluster_clean = cluster_name.replace(':', '_').replace('-', '_')
    new_id = f"fact_consolidated_{cluster_clean}_{hashlib.sha256(''.join(replaces).encode('utf-8')).hexdigest()[:8]}"

    # 提取标签与实体并集
    all_tags = sorted(list(set([t for item in items for t in (item.get('tags') or [])] + ['consolidated_insight'])))
    all_entities = sorted(list(set([e for item in items for e in (item.get('entities') or [])])))

    # 默认合成说明
    contents = [f"- {item.get('content', '')}" for item in items]
    merged_content = f"【受控沉淀事实】合并 {len(items)} 条历史排错/演进记录：\n" + "\n".join(contents)

    proposal = {
        'proposalId': f"prop_{new_id}",
        'cluster': cluster_name,
        'derivedFromIds': replaces,
        'replaces': replaces,
        'targetEntry': {
            'id': new_id,
            'kind': items[0].get('kind', 'fact'),
            'scope': items[0].get('scope', 'xiaoman_private'),
            'content': merged_content,
            'confidence': 1.0,
            'confirmed': True,
            'supersedesId': replaces[0],
            'supersedesIds': replaces,
            'validFrom': now,
            'validTo': None,
            'source': {
                'sessionId': 'offline_consolidation',
                'device': 'offline_tool',
                'channel': 'system',
                'evidenceText': f"合并 {len(items)} 笔关联记忆: {', '.join(replaces)}"
            },
            'status': 'active',
            'tags': all_tags,
            'entities': all_entities,
            'createdAt': now,
            'updatedAt': now,
        }
    }
    return proposal


def apply_consolidation(journal_path, target_entry, replaces):
    """原子化提交沉淀事务，写入 journal.jsonl"""
    entries, _ = replay_journal(journal_path)

    # 1. 安全前置检查：确认待替换条目均存在且当前为 active 状态
    for r_id in replaces:
        old = entries.get(r_id)
        if not old:
            raise ValueError(f"替换目标不存在: {r_id}")
        if old.get('status') != 'active':
            raise ValueError(f"替换目标当前不是 active 状态 ({old.get('status')}): {r_id}")

    if target_entry['id'] in entries:
        raise ValueError(f"目标条目 ID 已存在: {target_entry['id']}")

    # 2. 事务备份
    backup_path = f"{journal_path}.bak.{int(datetime.now().timestamp())}"
    shutil.copyfile(journal_path, backup_path)
    print(f"[✓] 已建立事务前安全快照: {backup_path}")

    # 3. 构造规范 Mutation
    timestamp = target_entry['updatedAt']
    op_id = target_entry['id']
    target_entry = normalize_json_types(target_entry)
    checksum = compute_mutation_digest(
        MUTATION_VERSION,
        'supersede',
        op_id,
        timestamp,
        replaces,
        target_entry
    )

    mutation_record = {
        'action': 'supersede',
        'mutationVersion': MUTATION_VERSION,
        'operationId': op_id,
        'timestamp': timestamp,
        'replaces': replaces,
        'checksum': checksum,
        'entry': target_entry,
    }

    # 4. 追加写入真源账本
    with open(journal_path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(mutation_record, ensure_ascii=False) + '\n')

    print(f"[✓] 事务提交成功！新条目 [{op_id}] 生效，归档 {len(replaces)} 笔旧记录。")
    return mutation_record


def main():
    parser = argparse.ArgumentParser(description="小满受控记忆沉淀离线工具 (Offline Memory Consolidator)")
    parser.add_argument('command', choices=['scan', 'preview', 'apply'], help="执行命令 (scan/preview: 扫描候选, apply: 提交事务)")
    parser.add_argument('--journal', default='/root/.dsh/profiles/memory/journal.jsonl', help="账本文件路径")
    parser.add_argument('--data-dir', default=None, help="记忆数据根目录")
    parser.add_argument('--proposal', default=None, help="apply 命令使用的提案 JSON 文件路径")
    parser.add_argument('--replaces', nargs='+', default=None, help="手动指定待替换的旧条目 ID 列表")
    parser.add_argument('--content', default=None, help="手动指定新条目的 content")

    args = parser.parse_args()

    journal_path = args.journal
    if args.data_dir:
        journal_path = os.path.join(args.data_dir, 'journal.jsonl')

    if not os.path.exists(journal_path):
        print(f"[!] 错误: 未找到账本文件: {journal_path}", file=sys.stderr)
        sys.exit(1)

    entries, _ = replay_journal(journal_path)
    active_entries, clusters = find_clusters(entries)

    if args.command in ('scan', 'preview'):
        print(f"=== [Memory Consolidator] 扫描账本: {journal_path} ===")
        print(f"总记录条目数: {len(entries)} | 当前活跃 (active) 条目数: {len(active_entries)}")
        print(f"发现冗余候选群组数: {len(clusters)}\n")

        if not clusters:
            print("[✓] 很好！当前所有活跃记忆条目均无冗余标签聚集，状态轻巧健康。")
            return

        proposals = []
        for cluster_name, items in clusters.items():
            print(f"--- 候选群组: {cluster_name} ({len(items)} 条活跃记录) ---")
            for it in items:
                print(f"  * [{it['id']}] {it.get('content', '')[:60]} (创建于: {it.get('createdAt')})")
            prop = build_proposal(cluster_name, items)
            proposals.append(prop)
            print(f"  👉 建议提案: 合并为新条目 [{prop['targetEntry']['id']}]\n")

        proposal_file = Path(journal_path).parent / 'dream_proposals.json'
        with open(proposal_file, 'w', encoding='utf-8') as f:
            json.dump(proposals, f, ensure_ascii=False, indent=2)
        print(f"[i] 已将 {len(proposals)} 份沉淀提案保存至: {proposal_file}")

    elif args.command == 'apply':
        if args.proposal:
            with open(args.proposal, 'r', encoding='utf-8') as f:
                prop_data = json.load(f)
            target_entry = prop_data.get('targetEntry')
            replaces = prop_data.get('replaces')
        elif args.replaces and args.content:
            now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
            replaces = args.replaces
            new_id = f"fact_manual_consolidated_{hashlib.sha256(''.join(replaces).encode('utf-8')).hexdigest()[:8]}"
            target_entry = {
                'id': new_id,
                'kind': 'fact',
                'scope': 'xiaoman_private',
                'content': args.content,
                'confidence': 1.0,
                'confirmed': True,
                'supersedesId': replaces[0],
                'supersedesIds': replaces,
                'validFrom': now,
                'validTo': None,
                'source': {'sessionId': 'cli_consolidation', 'device': 'manual'},
                'status': 'active',
                'tags': ['consolidated_insight'],
                'entities': [],
                'createdAt': now,
                'updatedAt': now,
            }
        else:
            print("[!] 错误: apply 命令必须提供 --proposal 或同时提供 --replaces 与 --content", file=sys.stderr)
            sys.exit(1)

        apply_consolidation(journal_path, target_entry, replaces)


if __name__ == '__main__':
    main()
