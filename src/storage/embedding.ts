import { pipeline, env } from "@xenova/transformers";

/**
 * 本地轻量 Embedding 语义模型服务
 * 
 * 知识点（针对 C 语言背景）：
 * 1. 这个模型只有约 90MB，底层由 ONNX Runtime (C++ 编写) 在本地 CPU 上通过 SIMD 指令加速执行。
 * 2. 它的输入是一段文字，输出是一个 Float32Array 数组（长度为 512 的 float 数组）。
 * 3. 我们在输出时开启了 normalize: true，即进行了 L2 归一化（向量长度为 1）。
 *    这样在计算余弦相似度时，两个向量的夹角余弦值直接等于它们的点积（Dot Product），无需额外做除法开根号！
 */
export class EmbeddingService {
  private static instance: EmbeddingService;
  private extractor: any = null;
  private isInitializing = false;

  private constructor() {
    // 允许本地缓存模型
    env.allowLocalModels = true;
  }

  public static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  public async init(): Promise<void> {
    if (this.extractor || this.isInitializing) return;
    this.isInitializing = true;
    try {
      console.error(">>> [AI 引擎] 正在初始化本地轻量语义模型 (Xenova/bge-small-zh-v1.5)...");
      // feature-extraction 管道：纯特征提取，无对话大模型包袱
      this.extractor = await pipeline("feature-extraction", "Xenova/bge-small-zh-v1.5");
      console.error(">>> [AI 引擎] 本地语义模型加载成功！纯 CPU 离线计算已就绪。");
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * 将一段文本转化为 512 维的浮点数向量 (float array)
   */
  public async getEmbedding(text: string): Promise<Float32Array> {
    await this.init();
    // 截取前 512 字符，防止过长
    const cleanText = text.slice(0, 512).replace(/\s+/g, " ").trim();
    const output = await this.extractor(cleanText, {
      pooling: "mean",
      normalize: true
    });
    return new Float32Array(output.data);
  }
}
