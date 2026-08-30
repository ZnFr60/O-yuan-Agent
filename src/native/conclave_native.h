// conclave_native.h
// Conclave 原生扩展公共头文件
// 提供文本归一化哈希、字符串相似度、缓存预处理、角色模板渲染、知识库预处理等高性能原语。
// 使用 Node-API (C) 实现，兼容 Node 16+，跨 Windows / Linux / macOS。
#ifndef CONCLAVE_NATIVE_H_
#define CONCLAVE_NATIVE_H_

#include <string>
#include <vector>
#include <cstdint>

namespace conclave {

// ---- 文本归一化 ----
// 归一化输入文本：折叠空白、统一大小写、标准化标点与参数顺序占位。
std::string NormalizeText(const std::string& input, bool lower = true);

// ---- 哈希 ----
// 稳定 64 位哈希 (FNV-1a 变体，与平台无关，进程间一致)。
uint64_t StableHash64(const std::string& data);

// 文本归一化哈希的十六进制字符串表示。
std::string NormalizedHashHex(const std::string& input);

// ---- 相似度 ----
// 余弦相似度（基于 UTF-8 字符 unigram 词袋），返回 [0,1]。
double CosineSimilarity(const std::string& a, const std::string& b);
// Jaccard 相似度（字符 2-gram 集合），返回 [0,1]。
double JaccardSimilarity(const std::string& a, const std::string& b);
// Levenshtein 距离。
size_t LevenshteinDistance(const std::string& a, const std::string& b);

// ---- 知识库预处理 ----
// 将长文本切分为带重叠的片段（chunk），返回片段列表。
std::vector<std::string> ChunkText(const std::string& text, size_t chunkSize, size_t overlap);
// 构建片段的关键词权重（简单词频+逆文档频率的简化版），返回 (token, weight) 列表。
std::vector<std::pair<std::string, double>> KeywordWeights(const std::string& text);

// ---- 角色模板渲染 ----
// 将角色 MD 档案渲染为系统提示字符串，支持 {placeholder} 替换。
std::string RenderRoleTemplate(const std::string& templateStr, const std::vector<std::pair<std::string,std::string>>& vars);

} // namespace conclave

#endif
