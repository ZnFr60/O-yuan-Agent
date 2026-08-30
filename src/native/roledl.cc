// roledl.cc - 角色模板渲染
#include "conclave_native.h"

namespace conclave {

std::string RenderRoleTemplate(const std::string& templateStr,
                               const std::vector<std::pair<std::string,std::string>>& vars) {
  std::string out = templateStr;
  for (const auto& kv : vars) {
    std::string key = "{" + kv.first + "}";
    size_t pos = 0;
    while ((pos = out.find(key, pos)) != std::string::npos) {
      out.replace(pos, key.size(), kv.second);
      pos += kv.second.size();
    }
  }
  return out;
}

} // namespace conclave
