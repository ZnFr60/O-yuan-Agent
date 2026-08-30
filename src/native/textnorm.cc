// textnorm.cc - 文本归一化
#include "conclave_native.h"
#include <algorithm>
#include <cctype>

namespace conclave {

// UTF-8 简化处理：按字节折叠 ASCII 大小写，空白折叠为单空格。
// 中文等多字节字符原样保留。
std::string NormalizeText(const std::string& input, bool lower) {
  std::string out;
  out.reserve(input.size());
  bool inSpace = false;
  size_t i = 0;
  const size_t n = input.size();
  while (i < n) {
    unsigned char c = (unsigned char)input[i];
    // 多字节 UTF-8 序列直接复制
    if (c >= 0x80) {
      if (inSpace) { out.push_back(' '); inSpace = false; }
      // 复制完整 UTF-8 序列 (1-4 字节)
      int len = 1;
      if (c >= 0xF0) len = 4;
      else if (c >= 0xE0) len = 3;
      else if (c >= 0xC0) len = 2;
      for (int k = 0; k < len && i < n; ++k) out.push_back(input[i++]);
      continue;
    }
    // ASCII 控制与空白 -> 折叠为单空格
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') {
      inSpace = true;
      ++i;
      continue;
    }
    if (inSpace) { out.push_back(' '); inSpace = false; }
    if (lower && c >= 'A' && c <= 'Z') c += 32;
    out.push_back((char)c);
    ++i;
  }
  if (inSpace && !out.empty()) out.push_back(' ');
  // 去掉首尾空白
  size_t start = out.find_first_not_of(' ');
  if (start == std::string::npos) return "";
  size_t end = out.find_last_not_of(' ');
  return out.substr(start, end - start + 1);
}

} // namespace conclave
