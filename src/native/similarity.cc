// similarity.cc - 字符串相似度
#include "conclave_native.h"
#include <unordered_map>
#include <unordered_set>
#include <algorithm>

namespace conclave {

// 提取 UTF-8 字符（或 unigram）到 vector<string>
static std::vector<std::string> SplitUnigrams(const std::string& s) {
  std::vector<std::string> out;
  size_t i = 0, n = s.size();
  while (i < n) {
    unsigned char c = (unsigned char)s[i];
    int len = 1;
    if (c >= 0xF0) len = 4;
    else if (c >= 0xE0) len = 3;
    else if (c >= 0xC0) len = 2;
    out.push_back(s.substr(i, std::min((size_t)len, n - i)));
    i += len;
  }
  return out;
}

static std::vector<std::string> NGrams(const std::string& s, int n) {
  auto u = SplitUnigrams(s);
  std::vector<std::string> out;
  if ((int)u.size() < n) { if (!u.empty()) out.push_back(s); return out; }
  for (size_t i = 0; i + n <= u.size(); ++i) {
    std::string gram;
    for (int k = 0; k < n; ++k) gram += u[i + k];
    out.push_back(gram);
  }
  return out;
}

double CosineSimilarity(const std::string& a, const std::string& b) {
  auto ua = SplitUnigrams(a);
  auto ub = SplitUnigrams(b);
  if (ua.empty() || ub.empty()) return 0.0;
  std::unordered_map<std::string, double> fa, fb;
  for (auto& t : ua) fa[t]++;
  for (auto& t : ub) fb[t]++;
  double dot = 0, na = 0, nb = 0;
  for (auto& p : fa) { dot += p.second * (fb.count(p.first) ? fb[p.first] : 0.0); na += p.second * p.second; }
  for (auto& p : fb) nb += p.second * p.second;
  if (na == 0 || nb == 0) return 0.0;
  return dot / (std::sqrt(na) * std::sqrt(nb));
}

double JaccardSimilarity(const std::string& a, const std::string& b) {
  auto ga = NGrams(a, 2);
  auto gb = NGrams(b, 2);
  if (ga.empty() || gb.empty()) return 0.0;
  std::unordered_set<std::string> sa(ga.begin(), ga.end());
  std::unordered_set<std::string> sb(gb.begin(), gb.end());
  size_t inter = 0;
  for (auto& g : sa) if (sb.count(g)) ++inter;
  size_t uni = sa.size() + sb.size() - inter;
  if (uni == 0) return 1.0;
  return (double)inter / (double)uni;
}

size_t LevenshteinDistance(const std::string& a, const std::string& b) {
  size_t m = a.size(), n = b.size();
  if (m == 0) return n;
  if (n == 0) return m;
  std::vector<size_t> prev(n + 1), cur(n + 1);
  for (size_t j = 0; j <= n; ++j) prev[j] = j;
  for (size_t i = 1; i <= m; ++i) {
    cur[0] = i;
    for (size_t j = 1; j <= n; ++j) {
      size_t cost = (a[i-1] == b[j-1]) ? 0 : 1;
      cur[j] = std::min({ prev[j] + 1, cur[j-1] + 1, prev[j-1] + cost });
    }
    prev.swap(cur);
  }
  return prev[n];
}

} // namespace conclave
