// kb.cc - 知识库预处理
#include "conclave_native.h"
#include <unordered_map>
#include <algorithm>
#include <cctype>

namespace conclave {

std::vector<std::string> ChunkText(const std::string& text, size_t chunkSize, size_t overlap) {
  std::vector<std::string> chunks;
  size_t n = text.size();
  if (n == 0) return chunks;
  if (chunkSize == 0) chunkSize = 1000;
  if (overlap >= chunkSize) overlap = chunkSize / 2;
  size_t pos = 0;
  while (pos < n) {
    size_t end = std::min(pos + chunkSize, n);
    chunks.push_back(text.substr(pos, end - pos));
    if (end == n) break;
    size_t next = end > overlap ? end - overlap : end;
    if (next <= pos) next = pos + 1; // 防止死循环
    pos = next;
  }
  return chunks;
}

// 将 UTF-8 字符串转为小写（ASCII 部分），用于关键词统计
static std::string ToLowerAscii(const std::string& s) {
  std::string out = s;
  for (char& c : out) if (c >= 'A' && c <= 'Z') c += 32;
  return out;
}

// 简单分词：提取连续的字母数字（含中文字符作为一个 token 的处理，这里把连续中文当整体）
static std::vector<std::string> Tokenize(const std::string& s) {
  std::vector<std::string> toks;
  std::string cur;
  size_t i = 0, n = s.size();
  auto flush = [&]() { if (!cur.empty()) { toks.push_back(cur); cur.clear(); } };
  while (i < n) {
    unsigned char c = (unsigned char)s[i];
    bool isAlnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    bool isCJK = (c >= 0xE0); // 高位字节视为中文等
    if (isAlnum) { cur.push_back((char)c); ++i; }
    else if (isCJK) {
      // 复制多字节序列作为 token
      int len = 1;
      if (c >= 0xF0) len = 4; else if (c >= 0xE0) len = 3; else if (c >= 0xC0) len = 2;
      flush();
      cur = s.substr(i, std::min((size_t)len, n - i));
      flush();
      i += len;
    }
    else { flush(); ++i; }
  }
  flush();
  return toks;
}

std::vector<std::pair<std::string, double>> KeywordWeights(const std::string& text) {
  std::vector<std::string> toks = Tokenize(text);
  std::unordered_map<std::string, size_t> freq;
  size_t total = 0;
  for (auto& t : toks) { std::string k = ToLowerAscii(t); if (!k.empty()) { freq[k]++; total++; } }
  std::vector<std::pair<std::string, double>> result;
  for (auto& p : freq) {
    if (p.second < 1) continue;
    // TF 权重，归一化到 [0,1]
    double w = (double)p.second / (double)(total ? total : 1);
    result.push_back({p.first, w});
  }
  std::sort(result.begin(), result.end(),
            [](const std::pair<std::string,double>& a, const std::pair<std::string,double>& b){ return a.second > b.second; });
  return result;
}

} // namespace conclave
