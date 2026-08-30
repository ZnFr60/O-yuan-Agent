// conclave_native.cc - Node-API 绑定入口
// 导出以下同步原语（全部为 CPU 轻量/中量计算，未做异步化：
// 关键长任务如知识库预处理由调用方放入 Worker Thread，本扩展保持线程安全只读）。
#include "conclave_native.h"
#include <napi.h>
#include <vector>
#include <string>
#include <utility>

namespace {

Napi::Value NormalizeTextWrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "normalizeText: expected a string").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string input = info[0].As<Napi::String>().Utf8Value();
  bool lower = true;
  if (info.Length() > 1 && info[1].IsBoolean()) lower = info[1].As<Napi::Boolean>().Value();
  std::string out = conclave::NormalizeText(input, lower);
  return Napi::String::New(env, out);
}

Napi::Value NormalizedHashWrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "normalizedHash: expected a string").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string input = info[0].As<Napi::String>().Utf8Value();
  return Napi::String::New(env, conclave::NormalizedHashHex(input));
}

Napi::Value CosineSimWrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "cosineSimilarity: expected two strings").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  double s = conclave::CosineSimilarity(info[0].As<Napi::String>().Utf8Value(),
                                        info[1].As<Napi::String>().Utf8Value());
  return Napi::Number::New(env, s);
}

Napi::Value JaccardSimWrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "jaccardSimilarity: expected two strings").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  double s = conclave::JaccardSimilarity(info[0].As<Napi::String>().Utf8Value(),
                                         info[1].As<Napi::String>().Utf8Value());
  return Napi::Number::New(env, s);
}

Napi::Value LevenshteinWrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "levenshteinDistance: expected two strings").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  size_t d = conclave::LevenshteinDistance(info[0].As<Napi::String>().Utf8Value(),
                                           info[1].As<Napi::String>().Utf8Value());
  return Napi::Number::New(env, (double)d);
}

Napi::Value ChunkTextWrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "chunkText: expected a string").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string text = info[0].As<Napi::String>().Utf8Value();
  size_t chunkSize = 1000;
  size_t overlap = 100;
  if (info.Length() > 1 && info[1].IsNumber()) chunkSize = (size_t)info[1].As<Napi::Number>().Int64Value();
  if (info.Length() > 2 && info[2].IsNumber()) overlap = (size_t)info[2].As<Napi::Number>().Int64Value();
  auto chunks = conclave::ChunkText(text, chunkSize, overlap);
  Napi::Array arr = Napi::Array::New(env, chunks.size());
  for (size_t i = 0; i < chunks.size(); ++i) arr.Set((uint32_t)i, Napi::String::New(env, chunks[i]));
  return arr;
}

Napi::Value KeywordWeightsWrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "keywordWeights: expected a string").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto kws = conclave::KeywordWeights(info[0].As<Napi::String>().Utf8Value());
  Napi::Array arr = Napi::Array::New(env, kws.size());
  for (size_t i = 0; i < kws.size(); ++i) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("token", Napi::String::New(env, kws[i].first));
    o.Set("weight", Napi::Number::New(env, kws[i].second));
    arr.Set((uint32_t)i, o);
  }
  return arr;
}

Napi::Value RenderRoleTemplateWrap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "renderRoleTemplate: expected a template string").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string tmpl = info[0].As<Napi::String>().Utf8Value();
  std::vector<std::pair<std::string,std::string>> vars;
  if (info.Length() > 1 && info[1].IsObject()) {
    Napi::Object obj = info[1].As<Napi::Object>();
    Napi::Array keys = obj.GetPropertyNames();
    for (uint32_t i = 0; i < keys.Length(); ++i) {
      std::string k = keys.Get(i).As<Napi::String>().Utf8Value();
      Napi::Value v = obj.Get(k);
      if (v.IsString()) vars.push_back({k, v.As<Napi::String>().Utf8Value()});
      else if (v.IsNumber()) vars.push_back({k, std::to_string(v.As<Napi::Number>().DoubleValue())});
    }
  }
  return Napi::String::New(env, conclave::RenderRoleTemplate(tmpl, vars));
}

} // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("normalizeText", Napi::Function::New(env, NormalizeTextWrap));
  exports.Set("normalizedHash", Napi::Function::New(env, NormalizedHashWrap));
  exports.Set("cosineSimilarity", Napi::Function::New(env, CosineSimWrap));
  exports.Set("jaccardSimilarity", Napi::Function::New(env, JaccardSimWrap));
  exports.Set("levenshteinDistance", Napi::Function::New(env, LevenshteinWrap));
  exports.Set("chunkText", Napi::Function::New(env, ChunkTextWrap));
  exports.Set("keywordWeights", Napi::Function::New(env, KeywordWeightsWrap));
  exports.Set("renderRoleTemplate", Napi::Function::New(env, RenderRoleTemplateWrap));
  return exports;
}

NODE_API_MODULE(conclave_native, Init)
