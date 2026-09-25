# Attention Is All You Need (MinerU 转换示例)

## 1. Introduction
主流的序列转导模型都基于复杂的循环神经网络或卷积神经网络，这些模型按时间步顺序计算，阻碍了并行化。

## 3. Architecture
Transformer 是第一个完全依靠自注意力机制来计算其输入和输出表示的转导模型，而不使用序列对齐的 RNN 或卷积。

### 3.2 Scaled Dot-Product Attention
我们称特定的注意力为“缩放点积注意力”（Scaled Dot-Product Attention）。输入由维度为 $d_k$ 的查询（Query）和键（Key），以及维度为 $d_v$ 的值（Value）组成。

计算输出矩阵的公式如下：
$$
\text{Attention}(Q, K, V) = \text{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right)V
$$

在这里，缩放因子 $\frac{1}{\sqrt{d_k}}$ 能够防止点积在维度较大时数值过大导致 softmax 梯度消失。

### 3.3 Multi-Head Attention
多头注意力机制（Multi-Head Attention）并不只执行单个注意力函数，而是通过线性投影把查询、键和值投影到不同的子空间中：
$$
\text{MultiHead}(Q, K, V) = \text{Concat}(\text{head}_1, \dots, \text{head}_h)W^O
$$
这使得模型能够同时关注来自不同位置的不同表征子空间的信息。
