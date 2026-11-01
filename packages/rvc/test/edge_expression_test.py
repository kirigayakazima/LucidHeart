"""Offline checks for text integrity and speech-boundary handling."""
import sys
from pathlib import Path
import unittest
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from edge_expression import build_plan, validate_plan, normalized, trim_outer_silence, SAMPLE_RATE


class ExpressionTests(unittest.TestCase):
    def test_punctuation_and_quotes_preserve_all_spoken_text(self):
        text = '欸，你回来啦！！“真的？！”\n我刚好有件事想跟你说。🙂'
        plan = build_plan(text)
        self.assertEqual(normalized(''.join(p['text'] for p in plan['parts'])), normalized(text))
        validate_plan(plan, text)
        self.assertTrue(all(p['text'] != '欸，' for p in plan['parts']))
        self.assertEqual(plan['parts'][-1]['gapMs'], 0)

    def test_custom_plan_cannot_drop_words_or_use_extreme_controls(self):
        text = '你回来啦！我有件事想跟你说。'
        plan = build_plan(text)
        plan['parts'][0]['text'] = '你好！'
        with self.assertRaisesRegex(ValueError, 'complete spoken text'): validate_plan(plan, text)
        plan = build_plan(text)
        plan['parts'][0]['rate'] = '+50%'
        with self.assertRaisesRegex(ValueError, 'rate'): validate_plan(plan, text)
        plan = build_plan(text)
        plan['parts'][0]['gapMs'] = -1
        with self.assertRaisesRegex(ValueError, 'gap'): validate_plan(plan, text)

    def test_only_outer_silence_is_trimmed_and_speech_is_unchanged(self):
        speech = np.full(SAMPLE_RATE // 5, .1, dtype=np.float32)
        audio = np.concatenate([np.zeros(4000), speech, np.zeros(2000), speech, np.zeros(4000)]).astype(np.float32)
        trimmed, metadata = trim_outer_silence(audio)
        np.testing.assert_array_equal(trimmed, audio[metadata['startSample']:metadata['endSample']])
        self.assertGreater(metadata['startSample'], 0)
        self.assertLess(metadata['endSample'], len(audio))
        np.testing.assert_array_equal(trimmed[trimmed != 0], np.concatenate([speech, speech]))
        self.assertGreaterEqual(np.count_nonzero(trimmed == 0), 2000)

    def test_silent_phrase_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'No speech'): trim_outer_silence(np.zeros(3200, dtype=np.float32))


if __name__ == '__main__':
    unittest.main()
