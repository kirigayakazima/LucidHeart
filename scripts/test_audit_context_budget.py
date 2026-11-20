import unittest

from audit_context_budget import audit, estimate_tokens


class ContextAuditTests(unittest.TestCase):
    def test_uses_only_model_schema_fields_and_ranks_parameter_descriptions(self):
        rows = [
            {"plugin": "memory", "name": "memory_recall", "description": "查事实", "execute": "never projected",
             "parameters": {"type": "object", "properties": {"query": {"description": "查" * 130}}}},
            {"name": "pc_status", "parameters": {"type": "object"}},
        ]
        result = audit(rows, "fixture")
        self.assertEqual(result["tools"], 2)
        self.assertEqual(result["topDescriptions"][0]["field"], "parameters.properties.query")
        self.assertEqual(len(result["over120"]), 1)
        self.assertEqual(result["byPlugin"]["host"]["tools"], 1)
        del rows[0]["execute"]
        self.assertEqual(audit(rows, "fixture"), result)

    def test_mixed_text_uses_utf16_units_for_emoji(self):
        self.assertEqual(estimate_tokens("a😀b"), 1)


if __name__ == "__main__":
    unittest.main()
