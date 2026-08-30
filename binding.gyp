{
  "targets": [
    {
      "target_name": "conclave_native",
      "sources": [
        "src/native/conclave_native.cc",
        "src/native/hash.cc",
        "src/native/similarity.cc",
        "src/native/textnorm.cc",
        "src/native/kb.cc",
        "src/native/roledl.cc"
      ],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "cflags_cc": ["-std=c++17"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        [ "OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": [ "/std:c++17", "/EHsc" ]
            }
          },
          "defines": [ "_CRT_SECURE_NO_WARNINGS", "NOMINMAX" ]
        }],
        [ "OS=='mac'", {
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.13",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
          }
        }],
        [ "OS=='linux'", {
          "cflags_cc": [ "-std=c++17", "-fexceptions" ],
          "cflags_cc!": [ "-fno-exceptions" ]
        }]
      ]
    }
  ]
}