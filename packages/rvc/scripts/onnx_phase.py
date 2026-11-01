"""PC export-time fix for long NSF phase accumulation; no inference dependency."""
import copy
import onnx
from onnx import TensorProto, helper


def stabilize_nsf_phase(model):
    """Return a copy whose two NSF CumSums accumulate in float64.

    Casting back immediately keeps the surrounding network in float32. Long
    sample-rate phase sums in ORT float32 drift from the native CPU reference;
    random short export inputs do not reliably expose this speech artifact.
    Fail on an unfamiliar graph instead of patching unrelated cumulative sums.
    """
    result = copy.deepcopy(model)
    if any(entry.key == 'lucidheart.nsf_phase_accumulator' for entry in result.metadata_props):
        raise ValueError('NSF precision patch already applied')
    targets = [node for node in result.graph.node if node.op_type == 'CumSum'
               and '/dec/m_source/l_sin_gen/' in node.name]
    if len(targets) != 2:
        raise ValueError(f'Expected exactly two NSF phase CumSums, found {len(targets)}')
    used = {name for node in result.graph.node for name in (*node.input, *node.output)}
    rewritten = []
    target_names = {node.name for node in targets}
    for node in result.graph.node:
        if node.name not in target_names:
            rewritten.append(node)
            continue
        source, output = node.input[0], node.output[0]
        wide_input, wide_output = output + '__input_phase_f64', output + '__phase_f64'
        if wide_input in used or wide_output in used:
            raise ValueError('NSF precision patch already applied or tensor name collision')
        used.update((wide_input, wide_output))
        rewritten.append(helper.make_node('Cast', [source], [wide_input],
                                          name=node.name + '_InputF64', to=TensorProto.DOUBLE))
        node.input[0], node.output[0] = wide_input, wide_output
        rewritten.append(node)
        rewritten.append(helper.make_node('Cast', [wide_output], [output],
                                          name=node.name + '_OutputF32', to=TensorProto.FLOAT))
    del result.graph.node[:]
    result.graph.node.extend(rewritten)
    entry = result.metadata_props.add()
    entry.key, entry.value = 'lucidheart.nsf_phase_accumulator', 'float64-v1'
    onnx.checker.check_model(result)
    return result
