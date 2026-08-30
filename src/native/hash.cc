// hash.cc - 稳定哈希实现
#include "conclave_native.h"

namespace conclave {

uint64_t StableHash64(const std::string& data) {
  // FNV-1a 64 位变体，偏移基数和素数固定，保证跨平台、跨进程一致。
  uint64_t hash = 14695981039346656037ULL;
  for (unsigned char c : data) {
    hash ^= c;
    hash *= 1099511628211ULL;
  }
  return hash;
}

std::string NormalizedHashHex(const std::string& input) {
  std::string norm = NormalizeText(input, true);
  uint64_t h = StableHash64(norm);
  const char* hex = "0123456789abcdef";
  std::string out(16, '0');
  for (int i = 0; i < 16; ++i) {
    out[i] = hex[(h >> (60 - i * 4)) & 0x0F];
  }
  return out;
}

} // namespace conclave
