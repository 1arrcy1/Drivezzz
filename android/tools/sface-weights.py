#!/usr/bin/env python3
# SFace (OpenCV Zoo, Apache-2.0) for the Android app's face match, which runs it in plain Kotlin (features/checks/SFace.kt) rather
# than carrying ONNX Runtime, 33 MB a CPU type. Each batch norm is folded into the layer before or after it, and the weights are kept
# in 16 bits, as the iPhone's Core ML model does: the same network, giving the same scores.
#
#   python3 -m venv venv && venv/bin/pip install numpy onnx onnxruntime
#   curl -LO https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx
#   venv/bin/python android/tools/sface-weights.py face_recognition_sface_2021dec.onnx android/app/src/main/assets/sface-2021dec-fp16.bin \
#       android/app/src/test/resources/sface-reference.txt
#
# The file: "SFC1", then the input's offset and scale (f32), the number of convolutions (i32), and per convolution in, out, kernel,
# stride, pad and groups (i32), its weights (f16, out × in/groups × k × k), bias and PReLU slopes (f32, out); then the last layer's
# in and out (i32), weights (f16, out × in) and bias (f32). Little-endian throughout.
# The reference: ONNX Runtime's answer for a made-up picture (SFaceTest builds the same one), to check the Kotlin against.
import struct
import sys

import numpy as np
import onnx
import onnxruntime
from onnx import numpy_helper

source, out_path, reference_path = sys.argv[1:4]
model = onnx.load(source)
graph = model.graph
W = {x.name: numpy_helper.to_array(x).astype(np.float64) for x in graph.initializer}
nodes = list(graph.node)


def attrs(n):
    return {a.name: onnx.helper.get_attribute_value(a) for a in n.attribute}


def bn(n):
    a = attrs(n)
    g, b, m, v = (W[x] for x in n.input[1:5])
    scale = g / np.sqrt(v + a.get('epsilon', 1e-5))
    return scale, b - m * scale


offset = float(W['scalar_op1'].reshape(-1)[0])
mul = float(W['scalar_op2'].reshape(-1)[0])
convs = []
i = 0
while i < len(nodes):
    n = nodes[i]
    if n.op_type == 'Conv':
        a = attrs(n)
        w = W[n.input[1]]
        bias = W[n.input[2]] if len(n.input) > 2 else np.zeros(w.shape[0])
        assert nodes[i + 1].op_type == 'BatchNormalization' and nodes[i + 2].op_type == 'PRelu'
        s, t = bn(nodes[i + 1])
        w = w * s[:, None, None, None]
        bias = bias * s + t
        slope = W[nodes[i + 2].input[1]].reshape(-1)
        assert a['kernel_shape'][0] == a['kernel_shape'][1] and len(set(a['pads'])) == 1 and a['strides'][0] == a['strides'][1]
        convs.append((w.shape[1] * a['group'], w.shape[0], a['kernel_shape'][0], a['strides'][0], a['pads'][0], a['group'], w, bias, slope))
        i += 3
        continue
    i += 1

# bn1 (per channel of the last 1024 × 7 × 7), then the fully connected layer, then fc1's batch norm: one layer.
by = {n.output[0]: n for n in nodes}
gemm = next(n for n in nodes if n.op_type == 'Gemm')
s1, t1 = bn(next(n for n in nodes if n.output[0] == 'bn1'))
fc_w = W[gemm.input[1]]  # out × in, as transB = 1
fc_b = W[gemm.input[2]]
area = fc_w.shape[1] // len(s1)
s1x = np.repeat(s1, area)
t1x = np.repeat(t1, area)
fc_b = fc_b + fc_w @ t1x
fc_w = fc_w * s1x[None, :]
s2, t2 = bn(next(n for n in nodes if n.output[0] == 'fc1'))
fc_w = fc_w * s2[:, None]
fc_b = fc_b * s2 + t2

with open(out_path, 'wb') as f:
    f.write(b'SFC1')
    f.write(struct.pack('<ffi', offset, mul, len(convs)))
    for (cin, cout, k, stride, pad, groups, w, bias, slope) in convs:
        f.write(struct.pack('<6i', cin, cout, k, stride, pad, groups))
        f.write(w.astype('<f2').tobytes())
        f.write(bias.astype('<f4').tobytes())
        f.write(slope.astype('<f4').tobytes())
    f.write(struct.pack('<2i', fc_w.shape[1], fc_w.shape[0]))
    f.write(fc_w.astype('<f2').tobytes())
    f.write(fc_b.astype('<f4').tobytes())

# A made-up picture, the same as SFaceTest's: every value from where it is.
y, x = np.mgrid[0:112, 0:112]
picture = np.stack([((x * 7 + y * 13 + c * 31) % 256) for c in range(3)]).astype(np.float32)[None]
answer = onnxruntime.InferenceSession(source).run(None, {graph.input[0].name: picture})[0][0]
with open(reference_path, 'w') as f:
    f.write(' '.join(f'{v:.6f}' for v in answer) + '\n')
print(f'{len(convs)} convolutions, {out_path}, reference in {reference_path}')
