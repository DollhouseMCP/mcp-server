// TEST ONLY: compile against the candidate's matching headers, without downloads.
#include <node.h>
namespace qualification {
void Answer(const v8::FunctionCallbackInfo<v8::Value>& args) {
  args.GetReturnValue().Set(42);
}
void Abi(const v8::FunctionCallbackInfo<v8::Value>& args) {
  args.GetReturnValue().Set(NODE_MODULE_VERSION);
}
void Initialize(v8::Local<v8::Object> exports) {
  NODE_SET_METHOD(exports, "answer", Answer);
  NODE_SET_METHOD(exports, "abi", Abi);
}
NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)
}
