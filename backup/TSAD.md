## Anomaly Transformer: Time Series Anomaly Detection with Association Discrepancy
### 假设
正常点可以与整个序列建立广泛的关联，注意力分布较分散。异常稀少且模式独特，难以与整个序列建立强关联，只能与邻近的少数点建立联系，注意力分布集中在局部。

### Loss函数
- Series-Association（序列关联）
**来源**：标准的自注意力权重（Self-Attention）
$S^l = \text{Softmax}\left(\frac{QK^T}{\sqrt{d_{model}}}\right)$
**含义**：模型从原始数据中学到的实际关联模式
- Prior-Association（先验关联）
**来源**：可学习的高斯核（Learnable Gaussian Kernel）
$P^l_{i,j} \propto \exp\left(-\frac{|j-i|^2}{2\sigma_i^2}\right)$
**含义**：强制体现"相邻集中"的归纳偏置
- 关联差异（Association Discrepancy）
关联差异是两种分布的**对称KL散度** ：

$$\text{AssDis}(\mathcal{P}, \mathcal{S}; \mathcal{X}) = \left[\frac{1}{L}\sum_{l=1}^{L}\left(\text{KL}(\mathcal{P}_{i,:}^l \| \mathcal{S}_{i,:}^l) + \text{KL}(\mathcal{S}_{i,:}^l \| \mathcal{P}_{i,:}^l)\right)\right]_{i=1,\cdots,N}$$

其中：
$\text{KL}(P \| S) = \sum_j P_j \log\frac{P_j}{S_j}$
$L$ 是Encoder层数
对每层的两种关联分别计算KL散度，再平均

### Minimax 训练策略
如果直接最大化关联差异，会导致**高斯核的尺度参数$\sigma$坍缩到0**（失去意义）。因此论文提出Minimax策略：
- Minimize Phase（最小化阶段） ，让 Prior-Association 去逼近 Series-Association
L_total = L_recon + λ · [KL(P || S_detach) + KL(S_detach || P)] 
梯度流向：
S_detach：停止梯度 ← Series-Association 固定不动
P：可学习    ← 只更新高斯核参数σ，让Prior去"追赶"Series

- Maximize Phase（最大化阶段），让 Series-Association 远离 Prior-Association
L_total = L_recon - λ · [KL(P_detach || S) + KL(S || P_detach)]
梯度流向：
P_detach：停止梯度 ← Prior-Association 固定不动 
S：可学习    ← 只更新Attention权重，让Series去"远离"Prior

loss1 = rec_loss - k * series_loss   # ← 实际这是Maximize Phase
loss2 = rec_loss + k * prior_loss    # ← 这是Minimize Phase